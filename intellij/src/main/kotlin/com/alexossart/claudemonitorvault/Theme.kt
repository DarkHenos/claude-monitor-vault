package com.alexossart.claudemonitorvault

import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.Color
import javax.swing.UIManager

// The extension's pages are styled with VS Code theme variables
// (--vscode-foreground, --vscode-charts-yellow...). They are filled here from
// the IDE's current Look and Feel, so a page follows Darcula, Light or any
// custom theme the way it follows a VS Code theme.
internal object Theme {

    private fun hex(c: Color?): String? {
        if (c == null) return null
        return if (c.alpha == 255) String.format("#%02x%02x%02x", c.red, c.green, c.blue)
        else String.format("#%02x%02x%02x%02x", c.red, c.green, c.blue, c.alpha)
    }

    private fun ui(key: String): Color? = UIManager.getColor(key)

    private fun mix(a: Color, b: Color, t: Double): Color = Color(
        (a.red + (b.red - a.red) * t).toInt(),
        (a.green + (b.green - a.green) * t).toInt(),
        (a.blue + (b.blue - a.blue) * t).toInt())

    val dark: Boolean get() = !JBColor.isBright()

    // VS Code's own chart colours, dark and light: the extension picks them by
    // name, and the user's band settings refer to them.
    private val charts: Map<String, Pair<String, String>> = mapOf(
        "blue" to ("#3794ff" to "#1a85ff"),
        "green" to ("#89d185" to "#388a34"),
        "yellow" to ("#cca700" to "#bf8803"),
        "orange" to ("#d18616" to "#d18616"),
        "red" to ("#f14c4c" to "#e51400"),
        "purple" to ("#b180d7" to "#652d90")
    )

    fun chart(name: String): Color {
        val pair = charts[name] ?: return UIUtil.getLabelForeground()
        return Color.decode(if (dark) pair.first else pair.second)
    }

    /** --vscode-* variables, plus --cmv-background for the page itself. */
    fun vars(editorTab: Boolean): Map<String, String> {
        val fg = UIUtil.getLabelForeground()
        val scheme = EditorColorsManager.getInstance().globalScheme
        val panel = JBUI.CurrentTheme.ToolWindow.background()
        val editor = scheme.defaultBackground
        val button = JBUI.CurrentTheme.Button.defaultButtonColorStart()
        val buttonFg = ui("Button.default.foreground") ?: Color.WHITE
        val secondary = JBUI.CurrentTheme.Button.buttonColorStart()
        val secondaryFg = ui("Button.foreground") ?: fg
        val input = UIUtil.getTextFieldBackground()
        val inputFg = UIUtil.getTextFieldForeground()
        val border = ui("Component.borderColor") ?: JBColor.border()
        val selection = UIUtil.getListSelectionBackground(true)
        val selectionFg = UIUtil.getListSelectionForeground(true)
        val popup = ui("PopupMenu.background") ?: UIUtil.getPanelBackground()
        val hover = runCatching { JBUI.CurrentTheme.List.Hover.background(true) }.getOrNull() ?: mix(panel, fg, 0.08)
        val font = UIUtil.getLabelFont()
        val m = linkedMapOf(
            "--cmv-background" to (if (editorTab) editor else panel),
            "--vscode-foreground" to fg,
            "--vscode-descriptionForeground" to UIUtil.getContextHelpForeground(),
            "--vscode-errorForeground" to UIUtil.getErrorForeground(),
            "--vscode-focusBorder" to JBUI.CurrentTheme.Focus.focusColor(),
            "--vscode-textLink-foreground" to JBUI.CurrentTheme.Link.Foreground.ENABLED,
            "--vscode-button-background" to button,
            "--vscode-button-foreground" to buttonFg,
            "--vscode-button-hoverBackground" to mix(button, buttonFg, 0.12),
            "--vscode-button-secondaryBackground" to secondary,
            "--vscode-button-secondaryForeground" to secondaryFg,
            "--vscode-button-secondaryHoverBackground" to mix(secondary, secondaryFg, 0.10),
            "--vscode-button-border" to border,
            "--vscode-checkbox-selectBackground" to button,
            "--vscode-input-background" to input,
            "--vscode-input-foreground" to inputFg,
            "--vscode-input-border" to border,
            "--vscode-dropdown-background" to input,
            "--vscode-dropdown-foreground" to inputFg,
            "--vscode-dropdown-border" to border,
            "--vscode-settings-dropdownBackground" to input,
            "--vscode-settings-dropdownForeground" to inputFg,
            "--vscode-settings-dropdownBorder" to border,
            "--vscode-list-hoverBackground" to hover,
            "--vscode-list-activeSelectionBackground" to selection,
            "--vscode-list-activeSelectionForeground" to selectionFg,
            "--vscode-menu-background" to popup,
            "--vscode-menu-foreground" to fg,
            "--vscode-menu-border" to border,
            "--vscode-menu-selectionBackground" to selection,
            "--vscode-menu-selectionForeground" to selectionFg,
            "--vscode-editorWidget-background" to popup,
            "--vscode-widget-border" to border,
            "--vscode-panel-border" to JBColor.border(),
            "--vscode-sideBar-background" to panel,
            "--vscode-editor-background" to editor
        ).mapValues { (_, c) -> hex(c) ?: "inherit" }.toMutableMap()
        for (name in charts.keys) m["--vscode-charts-$name"] = hex(chart(name))!!
        m["--vscode-font-family"] = "\"${font.family}\", system-ui, -apple-system, \"Segoe UI\", sans-serif"
        m["--vscode-font-size"] = "${font.size}px"
        m["--vscode-editor-font-family"] = "\"${scheme.editorFontName}\", ui-monospace, Consolas, monospace"
        return m
    }

    /** A theme colour id or literal sent by the extension, as a Swing colour. */
    fun color(value: String?): Color? {
        if (value.isNullOrBlank()) return null
        if (value.startsWith("#")) return parseHex(value)
        return when (value) {
            "statusBarItem.warningBackground" -> if (dark) Color(0x7a6400) else Color(0xf5c518)
            "statusBarItem.warningForeground" -> if (dark) Color.WHITE else Color(0x1f1f1f)
            "statusBarItem.errorBackground" -> Color(0xc72e0f)
            "statusBarItem.errorForeground" -> Color.WHITE
            "descriptionForeground" -> UIUtil.getContextHelpForeground()
            "foreground" -> UIUtil.getLabelForeground()
            "errorForeground" -> UIUtil.getErrorForeground()
            else -> if (value.startsWith("charts.")) chart(value.removePrefix("charts.")) else null
        }
    }

    private fun parseHex(s: String): Color? {
        var h = s.removePrefix("#")
        if (h.length == 3) h = h.map { "$it$it" }.joinToString("")
        return runCatching {
            when (h.length) {
                6 -> Color(h.toInt(16))
                8 -> Color(h.substring(0, 6).toInt(16) or (h.substring(6, 8).toInt(16) shl 24), true)
                else -> null
            }
        }.getOrNull()
    }
}
