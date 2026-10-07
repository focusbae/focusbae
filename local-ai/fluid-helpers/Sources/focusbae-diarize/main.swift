// FocusBae on-device speaker diarization helper (Apple Silicon, macOS 14+).
//
//   focusbae-diarize diarize --models <dir> --audio <16 kHz mono wav>
//     -> {"ok": true, "segments": [{"speaker": "S1", "startMs": 0, "endMs": 5480}]}
//   focusbae-diarize download --models <dir>
//     -> {"ok": true}
//
// `diarize` runs FluidAudio in offline mode: it never downloads, and missing models
// return code MODEL_MISSING. `download` is the only networked command; the app runs
// it solely after the user allows model downloads, then verifies every file against
// a pinned manifest before use. Speaker ids are per-file clusters, not identities.

import FluidAudio
import Foundation

struct Segment: Encodable {
    let speaker: String
    let startMs: Int
    let endMs: Int
}

struct Output: Encodable {
    let ok: Bool
    var segments: [Segment]? = nil
    var error: String? = nil
    var code: String? = nil
}

func emit(_ out: Output, status: Int32? = nil) -> Never {
    let data = (try? JSONEncoder().encode(out)) ?? Data("{\"ok\":false,\"code\":\"FAILED\"}".utf8)
    FileHandle.standardOutput.write(data)
    exit(status ?? (out.ok ? 0 : 1))
}

func option(_ name: String, _ arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

@main
struct Diarize {
    static func main() async {
        let arguments = CommandLine.arguments
        guard arguments.count > 1, let models = option("--models", arguments) else {
            emit(Output(ok: false, error: "usage", code: "INVALID_INPUT"), status: 2)
        }
        let directory = URL(fileURLWithPath: models, isDirectory: true)
        switch arguments[1] {
        case "download":
            ModelHub.offlineMode = false
            do {
                _ = try await OfflineDiarizerModels.load(from: directory)
                emit(Output(ok: true))
            } catch {
                emit(Output(ok: false, error: String(describing: error), code: "DOWNLOAD_FAILED"))
            }
        case "diarize":
            ModelHub.offlineMode = true
            guard let audio = option("--audio", arguments),
                  FileManager.default.isReadableFile(atPath: audio) else {
                emit(Output(ok: false, error: "audio file is missing", code: "INVALID_INPUT"), status: 2)
            }
            let loaded: OfflineDiarizerModels
            do {
                loaded = try await OfflineDiarizerModels.load(from: directory)
            } catch {
                emit(Output(ok: false, error: String(describing: error), code: "MODEL_MISSING"), status: 3)
            }
            do {
                let config = OfflineDiarizerConfig()
                let manager = OfflineDiarizerManager(config: config)
                manager.initialize(models: loaded)
                let source = try AudioSourceFactory().makeDiskBackedSource(
                    from: URL(fileURLWithPath: audio),
                    targetSampleRate: config.segmentation.sampleRate)
                defer { source.source.cleanup() }
                let result = try await manager.process(
                    audioSource: source.source,
                    audioLoadingSeconds: source.loadDuration) { _, _ in }
                let segments = result.segments.map {
                    Segment(
                        speaker: $0.speakerId,
                        startMs: Int(($0.startTimeSeconds * 1000).rounded()),
                        endMs: Int(($0.endTimeSeconds * 1000).rounded()))
                }
                emit(Output(ok: true, segments: segments))
            } catch {
                emit(Output(ok: false, error: String(describing: error), code: "FAILED"))
            }
        default:
            emit(Output(ok: false, error: "unknown command", code: "INVALID_INPUT"), status: 2)
        }
    }
}
