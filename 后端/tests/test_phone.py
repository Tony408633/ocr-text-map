"""手机接入相关的测试：证书、二维码、下载入口与自检接口。"""

from __future__ import annotations

import base64
import ssl


def test_certificates_are_valid_for_local_hosts():
    from paperpal import certs

    bundle = certs.ensure_certs(["127.0.0.1", "localhost", "192.168.1.50"])
    assert "192.168.1.50" in bundle.hosts

    # CA 与服务器证书都要能被 OpenSSL 接受（这是手机信任链的基础）
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(certs.server_cert_file()), str(certs.server_key_file()))

    decoded = ssl._ssl._test_decode_cert(str(certs.server_cert_file()))
    sans = decoded.get("subjectAltName") or ()
    assert ("IP Address", "127.0.0.1") in sans
    assert ("IP Address", "192.168.1.50") in sans
    assert ("DNS", "localhost") in sans

    fingerprint = bundle.fingerprint
    assert len(fingerprint.split(":")) == 32


def test_mobileconfig_embeds_the_ca():
    from paperpal import certs

    bundle = certs.ensure_certs(["127.0.0.1"])
    profile = certs.mobileconfig(bundle).decode("utf-8")
    assert profile.startswith("<?xml")
    assert "com.apple.security.root" in profile
    # 描述文件里必须真的带上 CA 的 DER，否则 iPhone 装上去也没用
    encoded = base64.b64encode(bundle.ca_der).decode("ascii")
    assert encoded[:64] in profile.replace("\n", "").replace(" ", "")


def test_lan_addresses_skip_loopback_and_tun():
    from paperpal import phone

    for item in phone.lan_addresses():
        assert not item["ip"].startswith("127.")
        assert not item["ip"].startswith("169.254.")
        assert not item["ip"].startswith("198.18.")


def test_phone_endpoint(client):
    response = client.get("/api/v1/phone")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["primary_url"].startswith("http")
    assert body["urls"] == [] or body["urls"][0]["url"].startswith("http")
    assert isinstance(body["steps"], list) and body["steps"]
    assert "fingerprint" in body["certificate"]
    assert "qr_target" in body
    # 有 segno 时应该给出内联 SVG，没有时字段为 None（前端会退回文字引导）
    assert "qr_svg" in body


def test_certificate_downloads(client):
    ca = client.get("/paperpal-ca.crt")
    assert ca.status_code == 200, ca.text
    assert "x-x509-ca-cert" in ca.headers["content-type"]
    assert ca.content.startswith(b"-----BEGIN CERTIFICATE-----")

    profile = client.get("/paperpal.mobileconfig")
    assert profile.status_code == 200, profile.text
    assert "x-apple-aspen-config" in profile.headers["content-type"]
    assert profile.content.startswith(b"<?xml")


def test_ocr_self_test(client):
    response = client.post("/api/v1/ocr/self-test")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert body["lines"]
    assert "elapsed_ms" in body


def test_diagnostics_endpoint(client):
    response = client.get("/api/v1/diagnostics")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["python"]
    assert body["ocr"]["ready"] is True
    assert "https_certs" in body
    assert body["packages"]["fastapi"]


def test_tunnel_public_url_wins_over_lan(client, monkeypatch):
    from paperpal import phone

    public = "https://example-tunnel.trycloudflare.com"
    monkeypatch.setattr(phone, "_public_url_alive", lambda url: True)
    try:
        phone.write_public_url(public)
        body = client.get("/api/v1/phone").json()
        assert body["mode"] == "tunnel"
        assert body["primary_url"] == public
        assert body["qr_target"] == public
        assert body["public_url"] == public
        # 隧道模式不需要局域网地址与防火墙提示
        assert body["urls"] == []
        assert body["diagnostic_url"] is None
        assert body["access"]["firewall"]["skipped"] is True
        assert any("证书" in step["text"] or "扫码" in step["title"] for step in body["steps"])
    finally:
        phone.clear_public_url()


def test_dead_tunnel_url_is_ignored(client):
    from paperpal import phone

    public = "https://dead-tunnel.trycloudflare.com"
    phone._public_url_cache["checked_at"] = 0
    phone._public_url_cache["value"] = None
    try:
        phone.write_public_url(public)
        # 连不上的隧道地址不能被当成可用地址，否则二维码会指向死链接
        assert phone.read_public_url() is None
        body = client.get("/api/v1/phone").json()
        assert body["mode"] != "tunnel"
    finally:
        phone.clear_public_url()


def test_public_url_file_expires(client, monkeypatch):
    import os
    import time

    from paperpal import phone

    monkeypatch.setattr(phone, "_public_url_alive", lambda url: True)
    public = "https://stale-tunnel.trycloudflare.com"
    try:
        phone.write_public_url(public)
        path = phone.public_url_file()
        old = time.time() - 13 * 3600
        os.utime(path, (old, old))
        assert phone.read_public_url() is None
        body = client.get("/api/v1/phone").json()
        assert body["mode"] != "tunnel"
    finally:
        phone.clear_public_url()


def test_firewall_status_shape():
    from paperpal import phone

    status = phone.firewall_status(8443)
    assert set(status) >= {"port_rule", "program_rule", "ok"}
    script = phone.firewall_script(8443, r"C:\Python312\python.exe")
    assert "netsh advfirewall firewall add rule" in script
    assert "localport=8443" in script
    assert "profile=any" in script
