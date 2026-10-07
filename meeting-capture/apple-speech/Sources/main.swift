// FocusBae on-device transcription helper (macOS 26+).
//
//   focusbae-transcribe <wav> [locale]        one file -> {"ok":true,"text":"..."}
//   focusbae-transcribe --status              {"ok":true,"locales":{"en-US":"installed",...}}
//   focusbae-transcribe --install <locale>    installs the macOS language asset (network, via macOS)
//   focusbae-transcribe --serve <locale>      one JSON request per stdin line:
//                                             {"id":"..","wav":".."} -> {"id":"..","ok":true,"text":".."}
//
// Transcription never downloads anything: a missing language asset returns
// code ASSET_MISSING (exit 3). Only --install asks macOS to fetch an asset, and the
// app runs it solely after an explicit user action with model downloads allowed.
//
// Hindi (hi-IN) is returned in Latin script by the system recognizer; that is the
// product's chosen representation (docs/benchmarks/speech.md, decision D-06).
//
// A separate binary rather than a Node addon: no Electron ABI coupling, and a crash
// cannot take the app down. BUILD: build.sh, macOS 26 SDK or newer.

import AVFoundation
import Foundation
import Speech

let knownLocales = ["en-US", "hi-IN"]

struct Output: Encodable {
    var id: String? = nil
    let ok: Bool
    var text: String? = nil
    var locales: [String: String]? = nil
    var error: String? = nil
    var code: String? = nil
}

func write(_ out: Output) {
    let data = (try? JSONEncoder().encode(out)) ?? Data("{\"ok\":false,\"code\":\"FAILED\"}".utf8)
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func emit(_ out: Output, status: Int32? = nil) -> Never {
    write(out)
    exit(status ?? (out.ok ? 0 : 1))
}

func makeTranscriber(_ identifier: String) async -> SpeechTranscriber? {
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier)) else {
        return nil
    }
    return SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
}

func installed(_ identifier: String) async -> Bool {
    let wanted = Locale(identifier: identifier).identifier(.bcp47)
    return await SpeechTranscriber.installedLocales.contains { $0.identifier(.bcp47) == wanted }
}

func transcribe(_ path: String, _ transcriber: SpeechTranscriber) async throws -> String {
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let audioFile = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    if let lastSample = try await analyzer.analyzeSequence(from: audioFile) {
        try await analyzer.finalizeAndFinish(through: lastSample)
    } else {
        await analyzer.cancelAndFinishNow()
    }
    var text = ""
    for try await result in transcriber.results {
        text += String(result.text.characters)
    }
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
}

// Resolves a locale that is supported and already installed, or exits with a code.
func readyTranscriber(_ identifier: String) async -> SpeechTranscriber {
    guard let transcriber = await makeTranscriber(identifier) else {
        emit(Output(ok: false, error: "\(identifier) is not supported on this Mac", code: "UNSUPPORTED"), status: 3)
    }
    guard await installed(identifier) else {
        emit(Output(ok: false, error: "\(identifier) language asset is not installed", code: "ASSET_MISSING"), status: 3)
    }
    return transcriber
}

struct Request: Decodable {
    let id: String
    let wav: String
}

@main
struct Transcribe {
    static func main() async {
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            emit(Output(ok: false, error: "usage", code: "INVALID_INPUT"), status: 2)
        }
        switch args[1] {
        case "--status":
            var locales: [String: String] = [:]
            for identifier in knownLocales {
                if await makeTranscriber(identifier) == nil {
                    locales[identifier] = "unsupported"
                } else {
                    locales[identifier] = await installed(identifier) ? "installed" : "supported"
                }
            }
            emit(Output(ok: true, locales: locales))

        case "--install":
            guard args.count >= 3, let transcriber = await makeTranscriber(args[2]) else {
                emit(Output(ok: false, error: "unsupported locale", code: "UNSUPPORTED"), status: 3)
            }
            do {
                if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                    try await request.downloadAndInstall()
                }
                guard await installed(args[2]) else {
                    emit(Output(ok: false, error: "asset still missing after install", code: "INSTALL_FAILED"))
                }
                emit(Output(ok: true))
            } catch {
                emit(Output(ok: false, error: String(describing: error), code: "INSTALL_FAILED"))
            }

        case "--serve":
            guard args.count >= 3 else {
                emit(Output(ok: false, error: "usage", code: "INVALID_INPUT"), status: 2)
            }
            let identifier = args[2]
            _ = await readyTranscriber(identifier)
            write(Output(ok: true))
            while let line = readLine() {
                guard let request = try? JSONDecoder().decode(Request.self, from: Data(line.utf8)) else {
                    write(Output(ok: false, error: "invalid request", code: "INVALID_INPUT"))
                    continue
                }
                do {
                    // A fresh module per file; the model itself stays loaded by macOS.
                    guard let transcriber = await makeTranscriber(identifier) else {
                        throw CocoaError(.featureUnsupported)
                    }
                    write(Output(id: request.id, ok: true, text: try await transcribe(request.wav, transcriber)))
                } catch {
                    write(Output(id: request.id, ok: false, error: String(describing: error), code: "FAILED"))
                }
            }
            exit(0)

        default:
            let path = args[1]
            guard FileManager.default.fileExists(atPath: path) else {
                emit(Output(ok: false, error: "file not found", code: "INVALID_INPUT"), status: 2)
            }
            let transcriber = await readyTranscriber(args.count >= 3 ? args[2] : "en-US")
            do {
                emit(Output(ok: true, text: try await transcribe(path, transcriber)))
            } catch {
                // Reported rather than swallowed: an empty transcript would look like
                // a recording where nobody spoke.
                emit(Output(ok: false, error: String(describing: error), code: "FAILED"))
            }
        }
    }
}
