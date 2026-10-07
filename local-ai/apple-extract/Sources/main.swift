// FocusBae on-device commitment extraction helper (macOS 26+, Apple Intelligence).
//
// Reads JSON on stdin:
//   {"owner": "Me", "segments": [{"id": "s1", "speaker": "Priya" | null, "text": "..."}]}
// Prints JSON on stdout:
//   {"ok": true, "commitments": [{"segmentId": "s1", "quote": "...", "owner": "self|other|unknown", "person": "..."}]}
//   {"ok": false, "error": "...", "code": "UNAVAILABLE|INVALID_INPUT|FAILED"}
//
// Uses Apple's system language model, so nothing is downloaded or sent anywhere.
// Output is schema-constrained; quotes are still re-checked against the source
// segment and dropped when they are not verbatim, because constrained decoding
// guarantees shape, not truth. Proposals only: nothing here accepts an action.

import Foundation
import FoundationModels

struct Segment: Decodable {
    let id: String
    let speaker: String?
    let text: String
}

struct Request: Decodable {
    let owner: String
    let segments: [Segment]
}

@Generable
enum Owner: String {
    case selfOwner = "self"
    case other
    case unknown
}

@Generable
struct Commitment {
    @Guide(description: "The id of the segment containing the commitment, exactly as given")
    let segmentId: String
    @Guide(description: "The exact words of the commitment copied from that segment, without paraphrasing")
    let quote: String
    @Guide(description: "self if the account owner will do it, other if another named person will, unknown if the speaker cannot be identified")
    let owner: Owner
    @Guide(description: "Name of the person who will do it, or empty when unknown")
    let person: String
}

@Generable
struct Extraction {
    // The model's 4,096-token context holds the instructions, the input AND this
    // answer. Uncapped, text dense with commitments made it list dozens of quotes,
    // overflow after ~85 s and lose all of them. The caller sends ~1,800-character
    // pieces, so a cap of 12 distinct commitments fits and rarely binds.
    @Guide(description: "Every distinct promise or accepted task in the conversation, each listed once; empty when there are none", .maximumCount(12))
    let commitments: [Commitment]
}

struct OutCommitment: Encodable {
    let segmentId: String
    let quote: String
    let owner: String
    let person: String
}

struct Output: Encodable {
    let ok: Bool
    var commitments: [OutCommitment]? = nil
    var text: String? = nil
    var error: String? = nil
    var code: String? = nil
}

// --rewrite: the same on-device model, asked to rewrite a passage the user
// selected. Unconstrained text rather than a schema, because the answer is prose.
struct RewriteRequest: Decodable {
    let style: String
    let text: String
}

let rewriteInstructions = [
    "proofread": """
        You correct writing. Fix spelling, grammar and punctuation only. Keep the author's \
        wording, voice and meaning exactly as they are. Do not add, remove or reorder ideas. \
        Keep every name, number, amount and date exactly as written. Reply with the corrected \
        text and nothing else.
        """,
    "tidy": """
        You make writing clearer. Keep the author's meaning, facts and voice. Keep every name, \
        number, amount and date exactly as written, including any [[link]] written in brackets. \
        Keep the point of view exactly: the author's "I" and "we" stay "I" and "we", and must \
        never become "you". Who promised what must not change. Do not invent detail, do not add \
        opinions, do not add a greeting or a sign-off. Reply with the rewritten text and nothing \
        else.
        """,
    "shorten": """
        You make writing shorter. Say the same thing in fewer words, keeping every name, number, \
        amount and date exactly as written, including any [[link]] written in brackets. Keep the \
        point of view exactly: the author's "I" and "we" stay "I" and "we", and must never become \
        "you". Never drop a commitment, a decision or a deadline. Reply with the shortened text \
        and nothing else.
        """,
]

func rewrite(_ input: Data) async -> Never {
    guard input.count <= 32_768,
          let request = try? JSONDecoder().decode(RewriteRequest.self, from: input),
          let instructions = rewriteInstructions[request.style],
          !request.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          request.text.count <= 8000 else {
        emit(Output(ok: false, error: "invalid request", code: "INVALID_INPUT"))
    }
    guard case .available = SystemLanguageModel.default.availability else {
        emit(Output(ok: false, error: "Apple Intelligence is unavailable", code: "UNAVAILABLE"))
    }
    do {
        let session = LanguageModelSession(instructions: instructions)
        let response = try await session.respond(
            to: request.text, options: GenerationOptions(sampling: .greedy))
        let text = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
        // An empty answer is a failure, not a rewrite that deletes the passage.
        guard !text.isEmpty else {
            emit(Output(ok: false, error: "empty rewrite", code: "FAILED"))
        }
        emit(Output(ok: true, text: text))
    } catch {
        emit(Output(ok: false, error: String(describing: error), code: "FAILED"))
    }
}

func emit(_ out: Output) -> Never {
    let data = (try? JSONEncoder().encode(out)) ?? Data("{\"ok\":false,\"code\":\"FAILED\"}".utf8)
    FileHandle.standardOutput.write(data)
    exit(out.ok ? 0 : 1)
}

let instructions = """
You find commitments in a conversation transcript. A commitment is a promise to do \
something or an explicit acceptance of a task, such as "I'll send it Friday", \
"I'm going to call them", "Let me check and get back to you", or "Raghav will own the script". Include commitments made by every speaker, not only \
the account owner: the account owner needs to track what others promised too.

Not commitments: predictions ("it will rain"), opinions ("the market will grow"), \
suggestions ("you should try it"), questions or requests that nobody accepted, and \
reports of what someone outside the conversation will do ("the speaker said she will publish").

Ownership: the person who will do the work. "I" and "me" refer to the speaker of that \
segment. Use self only when that person is the account owner. Use other when another \
identifiable person will do it. Use unknown when the speaker is not labelled and the \
doer cannot be identified. Copy quotes exactly from the segment.
"""

func normalize(_ s: String) -> String {
    s.lowercased().unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? String($0) : " " }
        .joined().split(separator: " ").joined(separator: " ")
}

@main
struct Extract {
    static func main() async {
        if CommandLine.arguments.contains("--status") {
            if case .available = SystemLanguageModel.default.availability {
                emit(Output(ok: true))
            }
            emit(Output(ok: false, error: String(describing: SystemLanguageModel.default.availability), code: "UNAVAILABLE"))
        }
        let input = FileHandle.standardInput.readDataToEndOfFile()
        if CommandLine.arguments.contains("--rewrite") { await rewrite(input) }
        guard input.count <= 1_048_576,
              let request = try? JSONDecoder().decode(Request.self, from: input),
              !request.segments.isEmpty, request.segments.count <= 400 else {
            emit(Output(ok: false, error: "invalid request", code: "INVALID_INPUT"))
        }
        guard case .available = SystemLanguageModel.default.availability else {
            emit(Output(ok: false, error: "Apple Intelligence is unavailable", code: "UNAVAILABLE"))
        }
        let transcript = request.segments.map { segment in
            "[\(segment.id)] \(segment.speaker ?? "Unlabelled speaker"): \(segment.text)"
        }.joined(separator: "\n")
        let prompt = "Account owner: \(request.owner)\n\nTranscript:\n\(transcript)"
        do {
            let session = LanguageModelSession(instructions: instructions)
            let response = try await session.respond(
                to: prompt, generating: Extraction.self,
                options: GenerationOptions(sampling: .greedy))
            if ProcessInfo.processInfo.environment["FOCUSBAE_EXTRACT_DEBUG"] == "1" {
                FileHandle.standardError.write(Data("raw: \(response.content)\n".utf8))
            }
            let byId = Dictionary(request.segments.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            let grounded = response.content.commitments.compactMap { item -> OutCommitment? in
                // The prompt shows ids as "[s1]"; the model sometimes copies the brackets.
                let id = item.segmentId.trimmingCharacters(in: CharacterSet(charactersIn: "[] "))
                guard let segment = byId[id],
                      !normalize(item.quote).isEmpty,
                      normalize(segment.text).contains(normalize(item.quote)) else { return nil }
                // An unlabelled speaker cannot be the account owner by inference alone.
                let owner = segment.speaker == nil && item.owner == .selfOwner ? "unknown" : item.owner.rawValue
                return OutCommitment(segmentId: id, quote: item.quote, owner: owner, person: item.person)
            }
            emit(Output(ok: true, commitments: grounded))
        } catch {
            emit(Output(ok: false, error: String(describing: error), code: "FAILED"))
        }
    }
}
