import SwiftUI

/// 阅读页：相机预览 + 当前行 + 朗读控制 + 自动扫描状态
struct LiveReaderView: View {
    let autoStart: Bool

    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var serverSettings: ServerSettings
    @Environment(\.dismiss) private var dismiss

    @StateObject private var model = ReaderModel()
    @State private var noteText = ""
    @State private var noteWholePage = false
    @State private var showNoteSheet = false
    @State private var showCameraStrip = true

    var body: some View {
        NavigationStack {
            VStack(spacing: 10) {
                if model.autoMode && showCameraStrip {
                    cameraStrip
                }
                readerCard
                controls
                autoBar
                Spacer(minLength: 0)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(model.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") {
                        model.stopEverything()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showNoteSheet = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .accessibilityLabel("添加批注")
                }
            }
            .task {
                model.attach(store: store, config: serverSettings.config)
                await model.start()
                if autoStart {
                    await model.startAuto()
                }
            }
            .onDisappear {
                model.stopEverything()
            }
            .sheet(isPresented: $showNoteSheet) {
                noteSheet
            }
        }
    }

    // MARK: 相机

    private var cameraStrip: some View {
        ZStack(alignment: .topTrailing) {
            CameraPreview(session: model.camera.session)
                .frame(height: 110)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .accessibilityHidden(true)
            Button {
                showCameraStrip = false
            } label: {
                Image(systemName: "eye.slash")
                    .padding(8)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .padding(8)
            .accessibilityLabel("隐藏取景画面")
        }
        .padding(.horizontal)
    }

    // MARK: 文字

    private var readerCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("第 \(model.pageNumber) 页")
                Spacer()
                Text(model.lines.isEmpty ? "等待识别" : "第 \(model.lineIndex + 1) / \(model.lines.count) 行")
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            if model.lines.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "book.pages")
                        .font(.largeTitle)
                        .foregroundStyle(.tertiary)
                    Text(model.status)
                        .multilineTextAlignment(.center)
                        .font(.subheadline)
                }
                .frame(maxWidth: .infinity, minHeight: 160)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(model.lines.enumerated()), id: \.element.id) { index, line in
                                Text(line.text)
                                    .font(.system(size: 22 * store.settings.fontSize,
                                                  weight: index == model.lineIndex ? .semibold : .regular))
                                    .foregroundStyle(index == model.lineIndex ? Color.primary : Color.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(10)
                                    .background(
                                        index == model.lineIndex ? Color.accentColor.opacity(0.12) : Color.clear,
                                        in: RoundedRectangle(cornerRadius: 10)
                                    )
                                    .id(line.id)
                                    .onTapGesture { model.jump(to: index) }
                                    .accessibilityLabel("第 \(index + 1) 行：\(line.text)")
                                    .accessibilityAddTraits(.isButton)
                            }
                        }
                    }
                    .frame(maxHeight: 320)
                    .onChange(of: model.lineIndex) { index in
                        guard model.lines.indices.contains(index) else { return }
                        withAnimation { proxy.scrollTo(model.lines[index].id, anchor: .center) }
                    }
                }
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
        .padding(.horizontal)
    }

    // MARK: 控制

    private var controls: some View {
        HStack(spacing: 10) {
            sideButton(title: "上一行", icon: "chevron.up") { model.previous() }
            Button {
                model.togglePlay()
            } label: {
                Label(model.isSpeaking ? "暂停" : "朗读",
                      systemImage: model.isSpeaking ? "pause.fill" : "play.fill")
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: 64)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityLabel(model.isSpeaking ? "暂停朗读" : "开始朗读当前行")
            sideButton(title: "下一行", icon: "chevron.down") { model.next() }
        }
        .padding(.horizontal)
    }

    private func sideButton(title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: icon)
                Text(title).font(.caption)
            }
            .frame(minWidth: 76, minHeight: 64)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel(title)
    }

    private var autoBar: some View {
        HStack(spacing: 10) {
            Image(systemName: model.autoMode ? "dot.radiowaves.left.and.right" : "info.circle")
                .foregroundStyle(model.autoMode ? Color.accentColor : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.status)
                    .font(.footnote)
                    .lineLimit(2)
                Text(model.modeText)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(model.autoMode ? "停止" : "自动扫描") {
                Task {
                    if model.autoMode {
                        model.stopAuto()
                    } else {
                        await model.startAuto()
                    }
                }
            }
            .buttonStyle(.bordered)
            .accessibilityHint("自动扫描会持续看图，翻页后自动读新的一页")
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal)
    }

    // MARK: 批注

    private var noteSheet: some View {
        NavigationStack {
            Form {
                Section("批注内容") {
                    TextEditor(text: $noteText)
                        .frame(minHeight: 120)
                        .accessibilityLabel("批注内容")
                }
                Section("范围") {
                    Toggle("整页批注", isOn: $noteWholePage)
                    Text(noteWholePage ? "保存到第 \(model.pageNumber) 页整页" : "保存到第 \(model.pageNumber) 页第 \(model.lineIndex + 1) 行")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if model.mode == .server {
                    Section {
                        Text("批注会保存到电脑上的纸伴服务")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("添加批注")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { showNoteSheet = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        let text = noteText
                        let whole = noteWholePage
                        showNoteSheet = false
                        noteText = ""
                        Task { await model.addNote(text, scope: whole ? .page : .line) }
                    }
                    .disabled(noteText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
