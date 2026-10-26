import SwiftUI
import UIKit

/// Which message is being selected from right now, one across the chat.
/// Holding a message offers Copy and Select Text; Select Text lays the
/// message's own words over it in a UIKit text view, which has the native
/// handles and Copy menu. A tap elsewhere in the transcript, the composer
/// taking focus or the selection collapsing ends it.
@Observable @MainActor final class MessageSelection {
    private(set) var active: UUID?
    @ObservationIgnored private var began = Date.distantPast
    @ObservationIgnored private var touchedInside = Date.distantPast

    func begin(_ id: UUID) {
        active = id
        began = .now
    }

    func end(_ id: UUID) {
        if active == id { active = nil }
    }

    /// The selectable text saw a touch: the transcript tap that follows is
    /// the person working the selection, not leaving it.
    func noteTouchInside() { touchedInside = .now }

    /// Ends the selection unless the tap is the one that just started it
    /// or one on the selectable text itself.
    func transcriptTapped() {
        guard active != nil, Date.now.timeIntervalSince(began) > 0.6,
              Date.now.timeIntervalSince(touchedInside) > 0.6 else { return }
        active = nil
    }

    static func copy(_ text: AttributedString) {
        UIPasteboard.general.string = String(text.characters)
    }
}

/// A message's text as UIKit draws it, for selecting from. It is laid over
/// the SwiftUI text at that text's size, so nothing moves when it comes or goes.
struct SelectableMessageText: UIViewRepresentable {
    let text: AttributedString
    let color: Color
    let linkColor: Color
    let touched: () -> Void
    let finished: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> SelectableMessageTextView {
        let view = SelectableMessageTextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.delegate = context.coordinator
        view.accessibilityIdentifier = "chat-message-selection"
        return view
    }

    func updateUIView(_ view: SelectableMessageTextView, context: Context) {
        view.touched = touched
        view.finished = finished
        view.linkTextAttributes = [.foregroundColor: UIColor(linkColor), .underlineStyle: NSUnderlineStyle.single.rawValue]
        context.coordinator.openURL = context.environment.openURL
        context.coordinator.apply(text, color: color, to: view)
    }

    /// The overlay proposes the SwiftUI text's exact size; take it.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: SelectableMessageTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? UIView.layoutFittingExpandedSize.width
        let fitting = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: proposal.width ?? fitting.width, height: proposal.height ?? fitting.height)
    }

    @MainActor final class Coordinator: NSObject, UITextViewDelegate {
        var openURL = OpenURLAction { _ in .systemAction }
        private var applied: (AttributedString, Color)?

        func apply(_ text: AttributedString, color: Color, to view: UITextView) {
            if let applied, applied.0 == text, applied.1 == color { return }
            applied = (text, color)
            view.attributedText = SelectableMessageText.render(text, color: UIColor(color))
        }

        // Links open the way the rest of the chat opens them.
        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            guard case .link(let url) = textItem.content else { return nil }
            let open = openURL
            return UIAction { _ in open(url) }
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            (textView as? SelectableMessageTextView)?.selectionChanged()
        }
    }

    /// The message's runs in the chat's text face, bold and italic as the
    /// sender wrote them, links carrying their URL.
    static func render(_ source: AttributedString, color: UIColor) -> NSAttributedString {
        let size = UIFontMetrics(forTextStyle: .body).scaledValue(for: 16)
        let family = UIFontDescriptor(fontAttributes: [.family: BrandFont.text])
        let result = NSMutableAttributedString()
        for run in source.runs {
            let font = run.swiftUI.font
            var traits: UIFontDescriptor.SymbolicTraits = []
            if font == Font.body.bold() || font == Font.body.bold().italic() { traits.insert(.traitBold) }
            if font == Font.body.italic() || font == Font.body.bold().italic() { traits.insert(.traitItalic) }
            let descriptor = family.withSymbolicTraits(traits) ?? family
            var attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont(descriptor: descriptor, size: size),
                .foregroundColor: color,
            ]
            if let url = run.link { attributes[.link] = url }
            result.append(NSAttributedString(string: String(source[run.range].characters), attributes: attributes))
        }
        return result
    }
}

final class SelectableMessageTextView: UITextView, UIEditMenuInteractionDelegate {
    var touched: (() -> Void)?
    var finished: (() -> Void)?
    private var selectsAll = true
    private lazy var selectionMenu = UIEditMenuInteraction(delegate: self)

    override func layoutSubviews() {
        super.layoutSubviews()
        guard selectsAll, bounds.width > 0, textStorage.length > 0 else { return }
        selectsAll = false
        selectedRange = NSRange(location: 0, length: textStorage.length)
        // Non-editable, so first responder brings the handles and the menu
        // without a keyboard. A programmatic selection does not show the
        // edit menu by itself; present it, with the text view's own actions.
        DispatchQueue.main.async { [weak self] in
            guard let self, window != nil else { return }
            becomeFirstResponder()
            if selectionMenu.view == nil { addInteraction(selectionMenu) }
            selectionMenu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: CGPoint(x: bounds.midX, y: 0)))
        }
    }

    /// Clearing the selection is leaving it.
    func selectionChanged() {
        guard !selectsAll, selectedRange.length == 0 else { return }
        DispatchQueue.main.async { [weak self] in self?.finished?() }
    }

    // A finger on the text, a handle or the loupe is not a tap elsewhere in
    // the transcript. Only real touches count, not accessibility hit tests.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let view = super.hitTest(point, with: event)
        if view != nil, event?.type == .touches { touched?() }
        return view
    }

    // The composer taking focus is a tap elsewhere too. Deferred, since
    // UIKit also resigns while tearing the view down.
    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned, window != nil {
            DispatchQueue.main.async { [weak self] in if self?.window != nil { self?.finished?() } }
        }
        return resigned
    }
}
