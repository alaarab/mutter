package com.alaarab.mutter.data

object SessionLimits {
    const val MESSAGES = 2000
    const val MESSAGE_CHARACTERS_IN_TOTAL = 8_000_000L
    const val MESSAGE_CHARACTERS = 2_000_000
    const val PROFILE_CHARACTERS = 256 * 1024
    const val NAME_CHARACTERS = 512
    const val USERS = 10_000
    const val CHANNELS = 10_000
    const val TOO_LARGE_MESSAGE = "<i>This message was too large to show.</i>"

    fun messageHtml(html: String) = if (html.length <= MESSAGE_CHARACTERS) html else TOO_LARGE_MESSAGE

    fun profileText(text: String) = if (text.length <= PROFILE_CHARACTERS) text else ""

    fun name(text: String) = text.take(NAME_CHARACTERS)

    fun messagesWith(messages: List<ChatMessage>, message: ChatMessage): List<ChatMessage> {
        val newest = (messages + message).takeLast(MESSAGES)
        var totalCharacters = newest.sumOf { it.html.length.toLong() }
        var oldestKept = 0
        while (totalCharacters > MESSAGE_CHARACTERS_IN_TOTAL && oldestKept < newest.lastIndex) {
            totalCharacters -= newest[oldestKept].html.length
            oldestKept++
        }
        return if (oldestKept == 0) newest else newest.subList(oldestKept, newest.size).toList()
    }
}
