// swift-tools-version: 6.0
import PackageDescription

// Pinned to the FluidAudio commit measured in
// docs/decisions/LF-09-LOCAL-AI-STACK.md §6a. Change deliberately.
let package = Package(
    name: "focusbae-fluid-helpers",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            revision: "b68f484789d81fda21efbf81e2ca9fcfd9dc22aa"),
    ],
    targets: [
        .executableTarget(
            name: "focusbae-diarize",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]),
        .executableTarget(
            name: "focusbae-asr",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]),
    ]
)
