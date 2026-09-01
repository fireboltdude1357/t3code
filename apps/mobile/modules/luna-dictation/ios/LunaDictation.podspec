Pod::Spec.new do |s|
  s.name           = 'LunaDictation'
  s.version        = '1.0.0'
  s.summary        = 'On-device dictation for the Luna voice sidecar.'
  s.description    = 'Wraps the iOS 26 DictationTranscriber with contextual-string biasing from the Luna dictionary.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
