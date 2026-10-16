# Other app audio during a Mutter conversation

AudioEngine already uses playAndRecord with mixWithOthers enabled by default; the
Mix with other apps setting controls that policy. voiceChat and voice-processing I/O
provide echo cancellation, noise suppression and AGC; disabling voice processing
selects default mode. Route selection and processing are unchanged.

Voice I/O also applies its own other-audio ducking. When mixing is enabled, select
advanced ducking at the minimum level so replies from apps such as Phren remain more
audible. When mixing is disabled retain the default ducking level. This does not
disable echo cancellation or promise zero ducking.

Apple documents the independent control in
[voiceProcessingOtherAudioDuckingConfiguration](https://developer.apple.com/documentation/avfaudio/avaudioinputnode/voiceprocessingotheraudioduckingconfiguration).
Output mixing does not grant another app microphone access. Mutter has no CallKit
provider, so another app cannot recognize it using CXCallObserver. Phren conservatively
waits while other app audio is playing; a silent non-CallKit capture requires physical
device testing. This change does not add CallKit or claim microphone sharing.

On an iOS 27 phone: connect Mutter with Mix with other apps on, play a Phren spoken
reply, and check both call ends for intelligibility and echo. Repeat speaker,
earpiece, wired headset and AirPods, while changing routes and mixing preference.
Repeat with voice processing off. Simulator/build evidence does not prove echo
cancellation, real call priority or Bluetooth behaviour.
