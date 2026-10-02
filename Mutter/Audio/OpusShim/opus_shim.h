#ifndef OPUS_SHIM_H
#define OPUS_SHIM_H

// Opus-iOS 1.9.0 packages upstream C headers as a framework without rewriting
// their includes or covering the multistream headers in its module umbrella.
// Keep these packaging diagnostics scoped to the vendor import; warnings in
// the shim and the rest of Mutter stay enabled.
#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wquoted-include-in-framework-header"
#pragma clang diagnostic ignored "-Wincomplete-umbrella"
#endif

#if __has_include(<opus/opus.h>)
#include <opus/opus.h>
#elif __has_include(<opus.h>)
#include <opus.h>
#else
#include "opus.h"
#endif

#if defined(__clang__)
#pragma clang diagnostic pop
#endif

#ifdef __cplusplus
extern "C" {
#endif

int opus_shim_set_bitrate(OpusEncoder *enc, int bitrate);
int opus_shim_set_vbr(OpusEncoder *enc, int enabled);
int opus_shim_set_inband_fec(OpusEncoder *enc, int enabled);
int opus_shim_set_packet_loss(OpusEncoder *enc, int percent);
int opus_shim_set_signal_voice(OpusEncoder *enc);
int opus_shim_set_complexity(OpusEncoder *enc, int complexity);
int opus_shim_encoder_reset(OpusEncoder *enc);
int opus_shim_decoder_reset(OpusDecoder *dec);

#ifdef __cplusplus
}
#endif

#endif
