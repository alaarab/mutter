package com.alaarab.mutter

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.alaarab.mutter.data.Server
import java.util.UUID
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class EditorTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()
    private val app
        get() = ui.activity.application as MutterApplication

    private val name = "Editor-${UUID.randomUUID().toString().take(8)}"

    private fun scrollTo(matcher: SemanticsMatcher): SemanticsNodeInteraction {
        ui.onAllNodes(hasScrollToNodeAction()).onLast().performScrollToNode(matcher)
        return ui.onNode(matcher).performScrollTo()
    }

    @After
    fun cleanup() {
        ui.runOnIdle {
            app.store.servers.value
                .filter { it.name.startsWith(name) }
                .forEach { app.store.deleteServer(it.id) }
        }
    }

    @Test
    fun editingServerSurvivesActivityRecreationWithoutDuplicatingOrLosingCredentials() {
        val original =
            Server(
                name = name,
                host = "example.invalid",
                username = "AndroidReview",
                password = "private-test-password",
                tokens = listOf("private-test-token"),
                fingerprint = "saved-test-pin",
                favorite = true,
            )
        ui.runOnIdle { app.store.saveServer(original) }
        scrollTo(hasContentDescription("Options for $name")).performClick()
        ui.onNodeWithText("Edit").performClick()
        scrollTo(hasContentDescription("Name") and hasSetTextAction())
            .performTextReplacement("$name-edited")
        scrollTo(hasContentDescription("Name") and hasSetTextAction())
            .assertTextContains("$name-edited")
        ui.activityRule.scenario.recreate()
        scrollTo(hasContentDescription("Name") and hasSetTextAction())
            .assertTextContains("$name-edited")
        ui.onNodeWithText("Save").performClick()
        ui.waitUntil(5000) {
            app.store.servers.value.any { it.id == original.id && it.name == "$name-edited" }
        }
        val saved =
            app.store.servers.value.filter {
                it.host == original.host && it.username == original.username
            }
        assertEquals("Editing after recreation duplicated the saved server", 1, saved.size)
        assertEquals(original.copy(name = "$name-edited"), saved.single())
    }

    @Test
    fun invalidPortIsRejectedAndCorrectedServerCanBeSaved() {
        ui.onNodeWithContentDescription("Add server").performClick()
        scrollTo(hasContentDescription("Name") and hasSetTextAction()).performTextReplacement(name)
        scrollTo(hasContentDescription("Address") and hasSetTextAction())
            .performTextReplacement("example.invalid")
        scrollTo(hasContentDescription("Port") and hasSetTextAction())
            .performTextReplacement("65536")
        scrollTo(hasContentDescription("Username") and hasSetTextAction())
            .performTextReplacement("AndroidReview")
        ui.onNodeWithText("Save").performClick()
        scrollTo(hasText("Enter a host name, a port from 1–65535, and your username."))
            .assertIsDisplayed()
        assertFalse(app.store.servers.value.any { it.name == name })
        scrollTo(hasContentDescription("Port") and hasSetTextAction())
            .performTextReplacement("64738")
        ui.onNodeWithText("Save").performClick()
        ui.waitUntil(5000) { app.store.servers.value.any { it.name == name } }
        assertEquals(64738, app.store.servers.value.first { it.name == name }.port)
    }
}
