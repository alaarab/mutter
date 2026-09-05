import SwiftUI
import UIKit

struct ViewedImage: Identifiable {
    let id = UUID()
    let image: UIImage
}

struct ImageViewerScreen: View {
    let image: UIImage
    @Environment(\.dismiss) private var dismiss
    @State private var drag: CGSize = .zero

    private var dragProgress: CGFloat { min(1, abs(drag.height) / 300) }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.opacity(1 - dragProgress * 0.7).ignoresSafeArea()
            ZoomableImage(image: image)
                .ignoresSafeArea()
                .offset(drag)
                .scaleEffect(1 - dragProgress * 0.15)
                .gesture(
                    DragGesture()
                        .onChanged { drag = $0.translation }
                        .onEnded { value in
                            if abs(value.translation.height) > 120 {
                                dismiss()
                            } else {
                                withAnimation(.spring(response: 0.3)) { drag = .zero }
                            }
                        }
                )
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.icon(15, .bold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(.white.opacity(0.15), in: Circle())
            }
            .padding(.trailing, 16)
            .padding(.top, 8)
            .opacity(1 - dragProgress)
        }
        .statusBarHidden()
    }
}

private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.delegate = context.coordinator
        scroll.maximumZoomScale = 6
        scroll.minimumZoomScale = 1
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.backgroundColor = .clear

        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFit
        imageView.frame = scroll.bounds
        imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scroll.addSubview(imageView)
        context.coordinator.imageView = imageView

        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)
        return scroll
    }

    func updateUIView(_ uiView: UIScrollView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        var imageView: UIImageView?

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        @objc func doubleTapped(_ gesture: UITapGestureRecognizer) {
            guard let scroll = gesture.view as? UIScrollView else { return }
            if scroll.zoomScale > 1 {
                scroll.setZoomScale(1, animated: true)
            } else {
                let point = gesture.location(in: imageView)
                let size = CGSize(width: scroll.bounds.width / 3, height: scroll.bounds.height / 3)
                let rect = CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2,
                                  width: size.width, height: size.height)
                scroll.zoom(to: rect, animated: true)
            }
        }
    }
}
