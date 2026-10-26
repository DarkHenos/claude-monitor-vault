package com.alexossart.claudemonitorvault

import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase

// The whole chain, inside a real IDE: the plugin starts Node, the unchanged
// extension activates through host/, and what it draws reaches the IDE's
// status bar model, the panel's webview model and an editor tab. JCEF is not
// available headless, so pages are checked as HTML, not rendered.
//
// build.gradle.kts gives this test a throwaway home: the extension sees an
// empty vault and an empty ~/.claude.
class ExtensionHostTest : BasePlatformTestCase() {

    private fun waitFor(what: String, condition: () -> Boolean) {
        val end = System.currentTimeMillis() + 60_000
        while (!condition()) {
            if (System.currentTimeMillis() > end) fail("timed out waiting for $what")
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            Thread.sleep(30)
        }
    }

    fun testTheExtensionRunsInTheIde() {
        val host = NodeHost.get(project)
        host.start()

        waitFor("the status bar item") { host.status.visible.isNotEmpty() }
        val status = host.status.visible.first()
        assertEquals("claudeLimits.open", status.str("command"))
        assertFalse("codicons reach the IDE: " + status.str("text"), status.str("text")!!.contains("$("))

        host.request("view.resolve", jsonOf("id" to Plugin.VIEW_ID))
        waitFor("the panel's page") { host.webviews.find(Plugin.VIEW_ID)?.html != null }
        assertTrue(host.webviews.find(Plugin.VIEW_ID)!!.html!!.contains("acquireVsCodeApi"))

        val fem = FileEditorManager.getInstance(project)
        host.executeCommand("claudeVault.audit")
        waitFor("the access log tab") { fem.openFiles.any { it is WebviewVirtualFile } }
        val tab = fem.openFiles.first { it is WebviewVirtualFile } as WebviewVirtualFile
        waitFor("the access log page") { host.webviews.find(tab.webviewId)?.html?.contains("<html") == true }

        // Closing the tab tells the extension, which forgets the panel: the
        // same command then opens a new one instead of revealing a dead one.
        fem.closeFile(tab)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        host.executeCommand("claudeVault.audit")
        waitFor("a fresh access log tab") {
            fem.openFiles.any { it is WebviewVirtualFile && it.webviewId != tab.webviewId }
        }
    }

    override fun tearDown() {
        try {
            val fem = FileEditorManager.getInstance(project)
            fem.openFiles.forEach { fem.closeFile(it) }
            NodeHost.get(project).stop()
        } finally {
            super.tearDown()
        }
    }
}
