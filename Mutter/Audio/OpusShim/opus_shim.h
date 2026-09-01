// Thin C wrappers around libopus' variadic opus_*_ctl() calls, which Swift cannot call directly.
#ifndef OPUS_SHIM_H
#define OPUS_SHIM_H

#if __has_include(<opus/opus.h>)
#include <opus/opus.h>
#elif __has_include(<opus.h>)
#include <opus.h>
#else
#include "opus.h"
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
