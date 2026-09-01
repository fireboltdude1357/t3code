import AVFoundation
import ExpoModulesCore
import Speech

/// On-device transcription for the Luna voice sidecar. Runs the same iOS 26
/// `SpeechTranscriber` engine as the composer mic (its model assets are shared,
/// so `prepare` is usually a no-op) and hands the Luna dictionary to the
/// analyzer through `AnalysisContext.contextualStrings`. Apple documents that
/// biasing for `DictationTranscriber`; whether `SpeechTranscriber` honors it is
/// undocumented, and setting it costs nothing either way. Corrections are
/// applied in JS afterwards. Transcription is batch: the sidecar records to a
/// file, then hands the file here.
public class LunaDictationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LunaDictation")

    AsyncFunction("isAvailable") { (locale: String) async -> Bool in
      guard #available(iOS 26.0, *) else { return false }
      guard SpeechTranscriber.isAvailable else { return false }
      return await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: locale)) != nil
    }

    // Downloads model assets if needed so the first recording does not pay for
    // them. The sidecar calls this when the sheet opens.
    AsyncFunction("prepare") { (locale: String) async throws -> Bool in
      guard #available(iOS 26.0, *) else {
        throw DictationUnavailableException()
      }
      let transcriber = try await LunaDictation.makeTranscriber(locale: locale)
      let status = await AssetInventory.status(forModules: [transcriber])
      switch status {
      case .installed:
        return true
      case .supported, .downloading:
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
          try await request.downloadAndInstall()
        }
        return true
      default:
        throw DictationUnavailableException()
      }
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
    "On-device transcription needs iOS 26 and a supported device language."
  }
}

final class DictationAudioFileException: Exception {
  override var reason: String {
    "The recording could not be opened for on-device transcription."
  }
}

@available(iOS 26.0, *)
enum LunaDictation {
  static func makeTranscriber(locale: String) async throws -> SpeechTranscriber {
    guard
      let resolved = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: locale))
    else {
      throw DictationUnavailableException()
    }
    let preset = SpeechTranscriber.Preset.transcription
    return SpeechTranscriber(
      locale: resolved,
      transcriptionOptions: preset.transcriptionOptions,
      reportingOptions: preset.reportingOptions,
      attributeOptions: preset.attributeOptions
    )
  }

  static func transcribeFile(
    uri: String,
    locale: String,
    contextualStrings: [String]
  ) async throws -> String {
    guard
      let url = URL(string: uri), url.isFileURL,
      let file = try? AVAudioFile(forReading: url)
    else {
      throw DictationAudioFileException()
    }

    let transcriber = try await makeTranscriber(locale: locale)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    if !contextualStrings.isEmpty {
      let context = AnalysisContext()
      context.contextualStrings = [.general: contextualStrings]
      try await analyzer.setContext(context)
    }

    // Collect results while the analyzer consumes the file; the sequence ends
    // once analysis finishes below.
    let collector = Task { () throws -> [String] in
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
      await analyzer.cancelAndFinishNow()
      _ = try? await collector.value
      throw error
    }

    return try await collector.value
      .joined(separator: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
