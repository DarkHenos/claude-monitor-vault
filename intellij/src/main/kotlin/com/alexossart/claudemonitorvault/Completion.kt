package com.alexossart.claudemonitorvault

import com.google.gson.JsonArray
import com.intellij.codeInsight.AutoPopupController
import com.intellij.codeInsight.completion.CompletionContributor
import com.intellij.codeInsight.completion.CompletionParameters
import com.intellij.codeInsight.completion.CompletionResultSet
import com.intellij.codeInsight.editorActions.TypedHandlerDelegate
import com.intellij.codeInsight.lookup.LookupElementBuilder
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiFile
import java.util.concurrent.TimeUnit

// Typing {{vault: offers the key names, in any file, as in VS Code. The list
// comes from the extension's own completion provider (vault/ui.js): names
// only, never a value.
private val MARKER = Regex("""\{\{([A-Za-z-]*)(?::([A-Za-z0-9_]*))?$""")

class MarkerCompletion : CompletionContributor() {
    override fun fillCompletionVariants(parameters: CompletionParameters, result: CompletionResultSet) {
        val editor = parameters.editor
        val doc = editor.document
        val offset = parameters.offset
        val line = doc.getLineNumber(offset)
        val start = doc.getLineStartOffset(line)
        val before = doc.getText(TextRange(start, offset))
        val m = MARKER.find(before) ?: return
        val project = parameters.position.project
        val host = NodeHost.get(project)
        if (!host.isRunning) return
        val file = parameters.originalFile.virtualFile
        val items = runCatching {
            host.request("completion.provide", jsonOf(
                "path" to file?.path, "line" to line, "character" to offset - start,
                "lineText" to doc.getText(TextRange(start, doc.getLineEndOffset(line)))
            )).get(800, TimeUnit.MILLISECONDS)
        }.getOrNull() as? JsonArray ?: return
        val typed = m.value
        val rs = result.withPrefixMatcher(typed)
        for (e in items) {
            val o = e.asJsonObject
            val insert = o.str("insertText") ?: continue
            rs.addElement(LookupElementBuilder.create(insert)
                .withLookupStrings(listOfNotNull(o.str("filterText"), insert.removeSuffix("}}")))
                .withPresentableText(o.str("label") ?: insert)
                .withTypeText(o.str("detail"), true)
                .withIcon(Icons.monitor))
        }
        rs.stopHere()
    }
}

class MarkerTypedHandler : TypedHandlerDelegate() {
    override fun checkAutoPopup(charTyped: Char, project: Project, editor: Editor, file: PsiFile): Result {
        if (charTyped != '{' && charTyped != ':') return Result.CONTINUE
        val offset = editor.caretModel.offset
        val doc = editor.document
        val start = doc.getLineStartOffset(doc.getLineNumber(offset))
        val before = doc.getText(TextRange(start, offset)) + charTyped
        if (MARKER.containsMatchIn(before)) AutoPopupController.getInstance(project).scheduleAutoPopup(editor)
        return Result.CONTINUE
    }
}
