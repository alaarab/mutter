#include "opus_shim.h"

int opus_shim_set_bitrate(OpusEncoder *enc, int bitrate) {
    return opus_encoder_ctl(enc, OPUS_SET_BITRATE(bitrate));
}

int opus_shim_set_vbr(OpusEncoder *enc, int enabled) {
    return opus_encoder_ctl(enc, OPUS_SET_VBR(enabled));
}

int opus_shim_set_inband_fec(OpusEncoder *enc, int enabled) {
    return opus_encoder_ctl(enc, OPUS_SET_INBAND_FEC(enabled));
}

int opus_shim_set_packet_loss(OpusEncoder *enc, int percent) {
    return opus_encoder_ctl(enc, OPUS_SET_PACKET_LOSS_PERC(percent));
}

int opus_shim_set_signal_voice(OpusEncoder *enc) {
    return opus_encoder_ctl(enc, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
}

int opus_shim_set_complexity(OpusEncoder *enc, int complexity) {
    return opus_encoder_ctl(enc, OPUS_SET_COMPLEXITY(complexity));
}

int opus_shim_encoder_reset(OpusEncoder *enc) {
    return opus_encoder_ctl(enc, OPUS_RESET_STATE);
}

int opus_shim_decoder_reset(OpusDecoder *dec) {
    return opus_decoder_ctl(dec, OPUS_RESET_STATE);
}
