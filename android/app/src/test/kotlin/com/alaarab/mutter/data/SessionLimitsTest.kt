package com.alaarab.mutter.data

import org.junit.Assert.*
import org.junit.Test

class SessionLimitsTest {
    private fun message(characters: Int) = ChatMessage(name = "Server", html = "x".repeat(characters))

    @Test
    fun historyKeepsTheNewestMessagesByCount() {
        var messages = emptyList<ChatMessage>()
        repeat(SessionLimits.MESSAGES + 5) {
            messages = SessionLimits.messagesWith(messages, message(1))
        }
        assertEquals(SessionLimits.MESSAGES, messages.size)
    }

    @Test
    fun historyDropsTheOldestMessagesWhenTheyHoldTooMuchText() {
        var messages = emptyList<ChatMessage>()
        repeat(10) { messages = SessionLimits.messagesWith(messages, message(1_500_000)) }
        val total = messages.sumOf { it.html.length.toLong() }
        assertTrue(total <= SessionLimits.MESSAGE_CHARACTERS_IN_TOTAL)
        assertEquals(5, messages.size)
    }

    @Test
    fun theNewestMessageIsAlwaysKept() {
        val huge = message(SessionLimits.MESSAGE_CHARACTERS)
        val messages =
            SessionLimits.messagesWith(
                List(5) { message(SessionLimits.MESSAGE_CHARACTERS) },
                huge,
            )
        assertSame(huge, messages.last())
    }

    @Test
    fun oversizedServerTextIsReplacedOrDropped() {
        assertEquals(
            SessionLimits.TOO_LARGE_MESSAGE,
            SessionLimits.messageHtml("x".repeat(SessionLimits.MESSAGE_CHARACTERS + 1)),
        )
        assertEquals("", SessionLimits.profileText("x".repeat(SessionLimits.PROFILE_CHARACTERS + 1)))
        assertEquals(SessionLimits.NAME_CHARACTERS, SessionLimits.name("x".repeat(100_000)).length)
        assertEquals("short", SessionLimits.messageHtml("short"))
    }
}
