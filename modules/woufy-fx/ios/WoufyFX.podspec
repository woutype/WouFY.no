Pod::Spec.new do |s|
  s.name           = 'WoufyFX'
  s.version        = '1.0.0'
  s.summary        = 'WouFY.no audio effects engine (reverb, 8D, tape speed) on AVAudioEngine'
  s.description    = 'Local Expo module: AVAudioEngine based player with reverb, 8D spatial audio and time/pitch effects.'
  s.author         = 'WouFY'
  s.homepage       = 'https://github.com/woutype/woufy'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.4'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
