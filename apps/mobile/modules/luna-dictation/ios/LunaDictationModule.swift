import AVFoundation
import ExpoModulesCore
import Speech

/// On-device dictation for the Luna voice sidecar. Uses the iOS 26
/// `DictationTranscriber` so the Luna dictionary can bias recognition through
/// `AnalysisContext.contextualStrings`; the newer `SpeechTranscriber` engine
/// offers no vocabulary hook. Transcription is batch: the sidecar records to a
/// file, then hands the file here.
public class LunaDictationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LunaDictation")

    AsyncFunction("isAvailable") { (locale: String) async -> Bool in
      guard #available(iOS 26.0, *) else { return false }
      return await LunaDictation.supportedLocale(matching: locale) != nil
    }

    AsyncFunction("transcribe") { (uri: String, locale: String, contextualStrings: [String]) async throws -> String in
      guard #available(iOS 26.0, *) else {
        throw DictationUnavailableException()
      }
      return try await LunaDictation.transcribeFile(
        uri: uri,
        locale: locale,
        contextualStrings: contextualStrings
      )
    }
  }
}

final class DictationUnavailableException: Exception {
  override var reason: String {
    "On-device dictation needs iOS 26 and a supported device language."
  }
}

final class DictationAudioFileException: Exception {
  override var reason: String {
    "The recording could not be opened for on-device dictation."
  }
}

@available(iOS 26.0, *)
enum LunaDictation {
  static func supportedLocale(matching identifier: String) async -> Locale? {
    let requested = Locale(identifier: identifier)
    let supported = await DictationTranscriber.supportedLocales
    if let exact = supported.first(where: {
      $0.identifier(.bcp47) == requested.identifier(.bcp47)
    }) {
      return exact
    }
    let language = requested.language.languageCode?.identifier
    return supported.first { $0.language.languageCode?.identifier == language }
  }

  static func transcribeFile(
    uri: String,
    locale: String,
    contextualStrings: [String]
  ) async throws -> String {
    guard let resolved = await supportedLocale(matching: locale) else {
      throw DictationUnavailableException()
    }
    guard
      let url = URL(string: uri), url.isFileURL,
      let file = try? AVAudioFile(forReading: url)
    else {
      throw DictationAudioFileException()
    }

    let transcriber = DictationTranscriber(locale: resolved, preset: .shortDictation)
    if let installation = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await installation.downloadAndInstall()
    }

    let analyzer = SpeechAnalyzer(modules: [transcriber], options: nil)
    if !contextualStrings.isEmpty {
      let context = AnalysisContext()
      context.contextualStrings = [.general: contextualStrings]
      try await analyzer.setContext(context)
    }

    // Collect results while the analyzer consumes the file; the sequence ends
    // once analysis finishes below.
    let collector = Task {
      var pieces: [String] = []
      for try await result in transcriber.results where result.isFinal {
        pieces.append(String(result.text.characters))
      }
      return pieces
    }

    do {
      if let lastSampleTime = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: lastSampleTime)
      } else {
        await analyzer.cancelAndFinishNow()
      }
    } catch {
      collector.cancel()
      throw error
    }

    return try await collector.value
      .joined(separator: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
