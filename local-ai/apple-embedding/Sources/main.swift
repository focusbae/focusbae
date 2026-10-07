import Foundation
import NaturalLanguage

struct Request: Decodable {
    let texts: [String]
}

struct Response: Encodable {
    let ok: Bool
    let profile: String?
    let dimensions: Int?
    let vectors: [[Double]]?
    let error: String?
}

func emit(_ response: Response, status: Int32 = 0) -> Never {
    if let data = try? JSONEncoder().encode(response) {
        FileHandle.standardOutput.write(data)
    }
    exit(status)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 1_048_576,
      let request = try? JSONDecoder().decode(Request.self, from: input),
      !request.texts.isEmpty,
      request.texts.count <= 128,
      request.texts.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 16_384 }) else {
    emit(Response(ok: false, profile: nil, dimensions: nil, vectors: nil, error: "invalid request"), status: 2)
}

let sentenceEmbedding = NLEmbedding.sentenceEmbedding(for: .english)
let wordEmbedding = NLEmbedding.wordEmbedding(for: .english)
guard let dimensions = sentenceEmbedding?.dimension ?? wordEmbedding?.dimension else {
    emit(Response(ok: false, profile: nil, dimensions: nil, vectors: nil, error: "English embeddings are unavailable"), status: 3)
}

func averageWordVector(_ text: String, embedding: NLEmbedding) -> [Double]? {
    let tokenizer = NLTokenizer(unit: .word)
    tokenizer.string = text
    var total = Array(repeating: 0.0, count: embedding.dimension)
    var count = 0
    tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
        if let vector = embedding.vector(for: String(text[range]).lowercased()) {
            for index in vector.indices { total[index] += vector[index] }
            count += 1
        }
        return true
    }
    guard count > 0 else { return nil }
    return total.map { $0 / Double(count) }
}

var vectors: [[Double]] = []
for text in request.texts {
    let vector = sentenceEmbedding?.vector(for: text) ?? wordEmbedding.flatMap { averageWordVector(text, embedding: $0) }
    guard let vector,
          vector.count == dimensions,
          vector.allSatisfy({ $0.isFinite }) else {
        emit(Response(ok: false, profile: nil, dimensions: nil, vectors: nil, error: "text could not be embedded"), status: 4)
    }
    vectors.append(vector)
}

emit(Response(
    ok: true,
    profile: sentenceEmbedding == nil ? "apple-nl-english-word-average-v1" : "apple-nl-english-sentence-v1",
    dimensions: dimensions,
    vectors: vectors,
    error: nil
))
