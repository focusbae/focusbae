// FocusBae optional English transcription helper: Parakeet TDT v3 via FluidAudio
// (Apple Silicon, macOS 14+).
//
//   focusbae-asr download --models <dir>   the only networked command
//   focusbae-asr serve --models <dir>      one JSON request per stdin line:
//                                          {"id":"..","wav":".."} -> {"id":"..","ok":true,"text":".."}
//
// `serve` runs FluidAudio in offline mode: missing models return MODEL_MISSING
// (exit 3) instead of downloading. The app verifies every model file against a
// pinned manifest before starting it.

import FluidAudio
import Foundation

let folder = "parakeet-tdt-0.6b-v3"

struct Output: Encodable {
    var id: String? = nil
    let ok: Bool
    var text: String? = nil
    var error: String? = nil
    var code: String? = nil
}

struct Request: Decodable {
    let id: String
    let wav: String
}

func write(_ out: Output) {
    let data = (try? JSONEncoder().encode(out)) ?? Data("{\"ok\":false,\"code\":\"FAILED\"}".utf8)
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func emit(_ out: Output, status: Int32? = nil) -> Never {
    write(out)
    exit(status ?? (out.ok ? 0 : 1))
}

func option(_ name: String, _ arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

@main
struct Asr {
    static func main() async {
        let arguments = CommandLine.arguments
        guard arguments.count > 1, let models = option("--models", arguments) else {
            emit(Output(ok: false, error: "usage", code: "INVALID_INPUT"), status: 2)
        }
        let directory = URL(fileURLWithPath: models, isDirectory: true)
            .appendingPathComponent(folder, isDirectory: true)
        switch arguments[1] {
        case "download":
            ModelHub.offlineMode = false
            do {
                try await AsrModels.download(to: directory, version: .v3)
                emit(Output(ok: true))
            } catch {
                emit(Output(ok: false, error: String(describing: error), code: "DOWNLOAD_FAILED"))
            }
        case "serve":
            ModelHub.offlineMode = true
            let manager: AsrManager
            do {
                let loaded = try await AsrModels.load(from: directory, version: .v3)
                manager = AsrManager(config: ASRConfig(
                    tdtConfig: TdtConfig(blankId: AsrModelVersion.v3.blankId),
                    encoderHiddenSize: AsrModelVersion.v3.encoderHiddenSize))
                try await manager.loadModels(loaded)
            } catch {
                emit(Output(ok: false, error: String(describing: error), code: "MODEL_MISSING"), status: 3)
            }
            write(Output(ok: true))
            while let line = readLine() {
                guard let request = try? JSONDecoder().decode(Request.self, from: Data(line.utf8)) else {
                    write(Output(ok: false, error: "invalid request", code: "INVALID_INPUT"))
                    continue
                }
                do {
                    var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
                    let result = try await manager.transcribe(
                        URL(fileURLWithPath: request.wav), decoderState: &state)
                    write(Output(id: request.id, ok: true, text: result.text))
                } catch {
                    write(Output(id: request.id, ok: false, error: String(describing: error), code: "FAILED"))
                }
            }
            exit(0)
        default:
            emit(Output(ok: false, error: "unknown command", code: "INVALID_INPUT"), status: 2)
        }
    }
}
