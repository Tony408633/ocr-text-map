"""本地 HTTPS 证书：不依赖 OpenSSL / mkcert / cryptography 的纯 Python 实现。

手机（尤其是 iPhone）只有在 **安全来源** 下才允许使用相机、Service Worker、
离线安装和 PWA 主屏幕图标。局域网用 ``http://192.168.x.x`` 打开时这些能力都会
被浏览器禁用，所以本模块在电脑上生成一套本地 CA + 服务器证书，并由后端用
HTTPS 提供服务：

* 第一次运行生成一个本地根证书（CA）和一张服务器证书，缓存在数据目录；
* 手机装一次 CA 描述文件（``.mobileconfig``）并信任它，之后相机、PWA 都可以用；
* 如果电脑换了局域网 IP，只需要重新签发服务器证书，手机不用重装。

为了在"没有 OpenSSL、没有 cryptography 包"的 Windows 电脑上也能工作，
这里包含了一个很小的 RSA 密钥生成器和 DER / X.509 编码器。
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import math
import os
import secrets
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import config

CA_COMMON_NAME = "PaperPal Local CA"
SERVER_COMMON_NAME = "paperpal.local"
CA_YEARS = 10
SERVER_DAYS = 825
#: 证书格式版本。编码器改动后递增，旧缓存会自动重建。
CERT_FORMAT = 2

# sha256WithRSAEncryption / rsaEncryption / 常用扩展
OID_SHA256_RSA = "1.2.840.113549.1.1.11"
OID_RSA = "1.2.840.113549.1.1.1"
OID_CN = "2.5.4.3"
OID_O = "2.5.4.10"
OID_BASIC_CONSTRAINTS = "2.5.29.19"
OID_KEY_USAGE = "2.5.29.15"
OID_EXT_KEY_USAGE = "2.5.29.37"
OID_SUBJECT_ALT_NAME = "2.5.29.17"
OID_SUBJECT_KEY_ID = "2.5.29.14"
OID_AUTHORITY_KEY_ID = "2.5.29.35"
OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1"

DIGEST_INFO_SHA256 = bytes.fromhex("3031300d060960864801650304020105000420")


# --------------------------------------------------------------------------- #
# DER 基础编码
# --------------------------------------------------------------------------- #


def _length(size: int) -> bytes:
    if size < 0x80:
        return bytes([size])
    body = size.to_bytes((size.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(body)]) + body


def _tlv(tag: int, body: bytes) -> bytes:
    return bytes([tag]) + _length(len(body)) + body


def _seq(*items: bytes) -> bytes:
    return _tlv(0x30, b"".join(items))


def _set(*items: bytes) -> bytes:
    return _tlv(0x31, b"".join(items))


def _integer_bytes(value: int) -> bytes:
    if value == 0:
        return b"\x00"
    body = value.to_bytes((value.bit_length() + 7) // 8, "big")
    if body[0] & 0x80:
        body = b"\x00" + body
    return body


def _int(value: int) -> bytes:
    return _tlv(0x02, _integer_bytes(value))


def _null() -> bytes:
    return b"\x05\x00"


def _oid(identifier: str) -> bytes:
    first, *rest = [int(part) for part in identifier.split(".")]
    body = bytearray([40 * first + rest[0]])
    for number in rest[1:]:
        chunk = bytearray([number & 0x7F])
        number >>= 7
        while number:
            chunk.insert(0, 0x80 | (number & 0x7F))
            number >>= 7
        body.extend(chunk)
    return _tlv(0x06, bytes(body))


def _octets(data: bytes) -> bytes:
    return _tlv(0x04, data)


def _bits(data: bytes, unused: int = 0) -> bytes:
    return _tlv(0x03, bytes([unused]) + data)


def _utf8(text: str) -> bytes:
    return _tlv(0x0C, text.encode("utf-8"))


def _utc_time(moment: datetime) -> bytes:
    return _tlv(0x17, moment.strftime("%y%m%d%H%M%SZ").encode("ascii"))


def _name(common_name: str, organization: str = "PaperPal") -> bytes:
    return _seq(
        _set(_seq(_oid(OID_CN), _utf8(common_name))),
        _set(_seq(_oid(OID_O), _utf8(organization))),
    )


def _algorithm() -> bytes:
    """签名算法标识（用于证书的 signature 字段）。"""
    return _seq(_oid(OID_SHA256_RSA), _null())


def _rsa_algorithm() -> bytes:
    """公钥算法标识：SubjectPublicKeyInfo 必须用它，不是签名算法。"""
    return _seq(_oid(OID_RSA), _null())


def _extension(oid: str, value: bytes, critical: bool = False) -> bytes:
    parts = [_oid(oid)]
    if critical:
        parts.append(b"\x01\x01\xff")
    parts.append(_octets(value))
    return _seq(*parts)


# --------------------------------------------------------------------------- #
# RSA
# --------------------------------------------------------------------------- #

_SMALL_PRIMES = [
    3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79,
    83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167,
    173, 179, 181, 191, 193, 197, 199, 211, 223, 227, 229, 233, 239, 241, 251, 257,
    263, 269, 271, 277, 281, 283, 293, 307, 311, 313, 317, 331, 337, 347, 349, 353,
]


def _is_probably_prime(number: int, rounds: int = 24) -> bool:
    if number < 2:
        return False
    for prime in _SMALL_PRIMES:
        if number % prime == 0:
            return number == prime
    d = number - 1
    shift = 0
    while d % 2 == 0:
        d //= 2
        shift += 1
    for _ in range(rounds):
        base = secrets.randbelow(number - 3) + 2
        value = pow(base, d, number)
        if value in (1, number - 1):
            continue
        for _ in range(shift - 1):
            value = pow(value, 2, number)
            if value == number - 1:
                break
        else:
            return False
    return True


def _generate_prime(bits: int, exponent: int) -> int:
    while True:
        candidate = secrets.randbits(bits) | (1 << (bits - 1)) | 1
        if (candidate - 1) % exponent == 0:
            continue
        if _is_probably_prime(candidate):
            return candidate


@dataclass
class RSAKey:
    """最小可用的 RSA 私钥（只做签名，不做加解密）。"""

    n: int
    e: int
    d: int
    p: int
    q: int
    dp: int
    dq: int
    qinv: int
    size: int

    @property
    def modulus_bytes(self) -> int:
        return (self.n.bit_length() + 7) // 8

    def sign(self, message: bytes) -> bytes:
        digest_info = DIGEST_INFO_SHA256 + hashlib.sha256(message).digest()
        size = self.modulus_bytes
        padding = size - len(digest_info) - 3
        if padding < 8:
            raise ValueError("密钥太短，无法签名。")
        encoded = b"\x00\x01" + b"\xff" * padding + b"\x00" + digest_info
        signature = pow(int.from_bytes(encoded, "big"), self.d, self.n)
        return signature.to_bytes(size, "big")

    def public_key_der(self) -> bytes:
        return _seq(_int(self.n), _int(self.e))

    def private_key_der(self) -> bytes:
        return _seq(
            _int(0),
            _int(self.n),
            _int(self.e),
            _int(self.d),
            _int(self.p),
            _int(self.q),
            _int(self.dp),
            _int(self.dq),
            _int(self.qinv),
        )


def generate_key(bits: int = 2048, *, deadline: float = 25.0) -> RSAKey:
    """生成 RSA 私钥；在 99% 的机器上 2048 位只需要一两秒。"""
    exponent = 65537
    started = time.monotonic()
    while True:
        if time.monotonic() - started > deadline:
            raise TimeoutError("生成 RSA 密钥超时，请重试。")
        half = bits // 2
        p = _generate_prime(half, exponent)
        q = _generate_prime(half, exponent)
        if p == q:
            continue
        n = p * q
        if n.bit_length() != bits:
            continue
        phi = math.lcm(p - 1, q - 1)
        d = pow(exponent, -1, phi)
        return RSAKey(
            n=n,
            e=exponent,
            d=d,
            p=p,
            q=q,
            dp=d % (p - 1),
            dq=d % (q - 1),
            qinv=pow(q, -1, p),
            size=bits,
        )


# --------------------------------------------------------------------------- #
# 证书
# --------------------------------------------------------------------------- #


def _subject_key_identifier(key: RSAKey) -> bytes:
    digest = hashlib.sha1(key.public_key_der()).digest()
    return _extension(OID_SUBJECT_KEY_ID, _octets(digest))


def _san_entries(hosts: list[str]) -> bytes:
    entries: list[bytes] = []
    for host in hosts:
        cleaned = str(host).strip()
        if not cleaned:
            continue
        try:
            address = ipaddress.ip_address(cleaned)
        except ValueError:
            entries.append(_tlv(0x82, cleaned.encode("ascii", "ignore")))
        else:
            entries.append(_tlv(0x87, address.packed))
    return _seq(*entries)


def _certificate(
    *,
    subject: str,
    issuer: str,
    key: RSAKey,
    signing_key: RSAKey,
    not_before: datetime,
    not_after: datetime,
    extensions: list[bytes],
    serial: int | None = None,
) -> bytes:
    serial = serial if serial is not None else secrets.randbits(64) | 1
    tbs = _seq(
        _tlv(0xA0, _int(2)),  # version v3
        _int(serial),
        _algorithm(),
        _name(issuer),
        _seq(_utc_time(not_before), _utc_time(not_after)),
        _name(subject),
        _seq(_rsa_algorithm(), _bits(key.public_key_der())),
        _tlv(0xA3, _seq(*extensions)),
    )
    signature = signing_key.sign(tbs)
    return _seq(tbs, _algorithm(), _bits(signature))


def _pem(label: str, der: bytes) -> str:
    body = base64.b64encode(der).decode("ascii")
    lines = [body[index : index + 64] for index in range(0, len(body), 64)]
    return f"-----BEGIN {label}-----\n" + "\n".join(lines) + f"\n-----END {label}-----\n"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _utc_stamp(moment: datetime) -> str:
    return moment.strftime("%Y%m%d%H%M%SZ")


@dataclass
class CertBundle:
    ca_cert_pem: str
    ca_key_pem: str
    server_cert_pem: str
    server_key_pem: str
    ca_der: bytes
    hosts: list[str]
    created_at: float

    @property
    def fingerprint(self) -> str:
        digest = hashlib.sha256(self.ca_der).hexdigest().upper()
        return ":".join(digest[i : i + 2] for i in range(0, len(digest), 2))


def certs_dir() -> Path:
    return config.data_dir() / "https"


def ensure_certs(hosts: list[str]) -> CertBundle:
    """读取缓存的证书；IP 变化时只重签服务器证书。"""
    directory = certs_dir()
    directory.mkdir(parents=True, exist_ok=True)
    ca_cert_path = directory / "ca.crt"
    ca_key_path = directory / "ca.key"
    server_cert_path = directory / "server.crt"
    server_key_path = directory / "server.key"
    meta_path = directory / "meta.json"

    wanted = sorted({str(host).strip() for host in hosts if str(host).strip()})
    meta: dict = {}
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            meta = {}

    ca_ready = ca_cert_path.is_file() and ca_key_path.is_file()
    ca_fresh = (
        ca_ready
        and meta.get("format") == CERT_FORMAT
        and meta.get("ca_created", 0) > time.time() - (CA_YEARS - 1) * 365 * 86400
    )
    if not ca_fresh:
        ca_key = generate_key(2048)
        now = _now()
        ca_der = _certificate(
            subject=CA_COMMON_NAME,
            issuer=CA_COMMON_NAME,
            key=ca_key,
            signing_key=ca_key,
            not_before=now - timedelta(days=1),
            not_after=now + timedelta(days=365 * CA_YEARS),
            extensions=[
                _extension(OID_BASIC_CONSTRAINTS, _seq(b"\x01\x01\xff"), critical=True),
                _extension(OID_KEY_USAGE, _bits(b"\x06", unused=1), critical=True),
                _extension(OID_EXT_KEY_USAGE, _seq(_oid(OID_SERVER_AUTH))),
                _subject_key_identifier(ca_key),
            ],
        )
        ca_cert_path.write_text(_pem("CERTIFICATE", ca_der), encoding="ascii")
        ca_key_path.write_text(_pem("RSA PRIVATE KEY", ca_key.private_key_der()), encoding="ascii")
        meta = {
            "format": CERT_FORMAT,
            "ca_created": time.time(),
            "ca_not_after": _utc_stamp(now + timedelta(days=365 * CA_YEARS)),
            "server_hosts": [],
        }
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        server_cert_path.unlink(missing_ok=True)

    if meta.get("server_hosts") != wanted or not server_cert_path.is_file():
        ca_key_pem = ca_key_path.read_text(encoding="ascii")
        ca_key = _load_key(ca_key_pem)
        now = _now()
        server_key = generate_key(2048)
        server_der = _certificate(
            subject=SERVER_COMMON_NAME,
            issuer=CA_COMMON_NAME,
            key=server_key,
            signing_key=ca_key,
            not_before=now - timedelta(days=1),
            not_after=now + timedelta(days=SERVER_DAYS),
            extensions=[
                _extension(OID_KEY_USAGE, _bits(b"\xa0", unused=5), critical=True),
                _extension(OID_EXT_KEY_USAGE, _seq(_oid(OID_SERVER_AUTH))),
                _extension(OID_SUBJECT_ALT_NAME, _san_entries(wanted)),
                _subject_key_identifier(server_key),
            ],
        )
        server_cert_path.write_text(_pem("CERTIFICATE", server_der), encoding="ascii")
        server_key_path.write_text(
            _pem("RSA PRIVATE KEY", server_key.private_key_der()), encoding="ascii"
        )
        meta["server_hosts"] = wanted
        meta["server_created"] = time.time()
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    ca_pem = ca_cert_path.read_text(encoding="ascii")
    ca_der = base64.b64decode(
        "".join(line for line in ca_pem.splitlines() if not line.startswith("-----"))
    )
    return CertBundle(
        ca_cert_pem=ca_pem,
        ca_key_pem=ca_key_path.read_text(encoding="ascii"),
        server_cert_pem=server_cert_path.read_text(encoding="ascii"),
        server_key_pem=server_key_path.read_text(encoding="ascii"),
        ca_der=ca_der,
        hosts=wanted,
        created_at=float(meta.get("ca_created", 0)),
    )


def server_cert_file() -> Path:
    return certs_dir() / "server.crt"


def server_key_file() -> Path:
    return certs_dir() / "server.key"


def _read_tlv(data: bytes, index: int) -> tuple[int, bytes, int]:
    tag = data[index]
    (length, start) = _skip_length(data, index + 1)
    return tag, data[start : start + length], start + length


def _load_key(pem_text: str) -> RSAKey:
    """从 PEM(PKCS#1) 读回私钥，只解析我们自己写出的格式。"""
    body = "".join(line for line in pem_text.splitlines() if not line.startswith("-----"))
    der = base64.b64decode(body)
    _tag, sequence, _end = _read_tlv(der, 0)
    values: list[int] = []
    index = 0
    while index < len(sequence):
        tag, chunk, index = _read_tlv(sequence, index)
        if tag == 0x02:
            values.append(int.from_bytes(chunk, "big"))
    version, n, e, d, p, q, dp, dq, qinv = values[:9]
    del version
    return RSAKey(n=n, e=e, d=d, p=p, q=q, dp=dp, dq=dq, qinv=qinv, size=n.bit_length())


def _skip_length(data: bytes, index: int) -> tuple[int, int]:
    first = data[index]
    if first < 0x80:
        return first, index + 1
    count = first & 0x7F
    length = int.from_bytes(data[index + 1 : index + 1 + count], "big")
    return length, index + 1 + count


# --------------------------------------------------------------------------- #
# iOS 描述文件
# --------------------------------------------------------------------------- #


def mobileconfig(bundle: CertBundle, *, base_url: str = "") -> bytes:
    """生成 iOS / iPadOS 的证书描述文件，Safari 打开即可一键安装。"""
    cert_uuid = str(uuid.uuid4()).upper()
    profile_uuid = str(uuid.uuid4()).upper()
    payload = base64.b64encode(bundle.ca_der).decode("ascii")
    payload_lines = [payload[index : index + 64] for index in range(0, len(payload), 64)]
    payload_xml = "\n".join(payload_lines)
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>PayloadCertificateFileName</key>
            <string>paperpal-ca.cer</string>
            <key>PayloadContent</key>
            <data>
{payload_xml}
            </data>
            <key>PayloadDescription</key>
            <string>允许这台设备信任电脑上的纸伴服务（相机、离线安装需要）。</string>
            <key>PayloadDisplayName</key>
            <string>纸伴 PaperPal 本机证书</string>
            <key>PayloadIdentifier</key>
            <string>local.paperpal.ca.{cert_uuid}</string>
            <key>PayloadType</key>
            <string>com.apple.security.root</string>
            <key>PayloadUUID</key>
            <string>{cert_uuid}</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
        </dict>
    </array>
    <key>PayloadDescription</key>
    <string>安装后在“设置 → 通用 → 关于本机 → 证书信任设置”里打开完全信任，手机即可用相机扫描书页。</string>
    <key>PayloadDisplayName</key>
    <string>纸伴 PaperPal 本机证书</string>
    <key>PayloadIdentifier</key>
    <string>local.paperpal.profile.{profile_uuid}</string>
    <key>PayloadOrganization</key>
    <string>PaperPal</string>
    <key>PayloadRemovalDisallowed</key>
    <false/>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>{profile_uuid}</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>
"""
    return xml.encode("utf-8")


def ca_fingerprint_short(bundle: CertBundle) -> str:
    return bundle.fingerprint.replace(":", "")[:16]


if __name__ == "__main__":  # pragma: no cover - 手动检查用
    os.environ.setdefault("PAPERPAL_DATA_DIR", str(Path(__file__).resolve().parents[1] / "data"))
    started = time.monotonic()
    result = ensure_certs(["localhost", "127.0.0.1", "192.168.1.10"])
    print(f"CA：{result.fingerprint}")
    print(f"主机：{result.hosts}")
    print(f"耗时：{time.monotonic() - started:.1f}s")
