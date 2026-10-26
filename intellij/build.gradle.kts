import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.2.20"
    id("org.jetbrains.intellij.platform") version "2.5.0"
}

// The extension this plugin runs. Its manifest is the single source for the
// version and the names, so the VS Code and IntelliJ builds of a release can
// never disagree on what they are.
val extensionDir: File = layout.projectDirectory.dir("..").asFile
@Suppress("UNCHECKED_CAST")
val manifest = JsonSlurper().parse(File(extensionDir, "package.json")) as Map<String, Any>

group = "com.alexossart"
version = manifest["version"] as String

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        val local = providers.gradleProperty("platformLocalPath").orNull
        if (local != null) local(local) else intellijIdeaCommunity(providers.gradleProperty("platformVersion"))
        bundledPlugin("org.jetbrains.plugins.terminal")
        testFramework(org.jetbrains.intellij.platform.gradle.TestFrameworkType.Platform)
    }
    testImplementation("junit:junit:4.13.2")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        // 2023.1 ships Kotlin 1.8: nothing newer from the standard library.
        apiVersion.set(KotlinVersion.KOTLIN_1_8)
    }
}

intellijPlatform {
    pluginConfiguration {
        id = "alexossart.claude-monitor-vault"
        name = manifest["displayName"] as String
        version = manifest["version"] as String
        description = (manifest["description"] as String).replace("in VS Code", "in JetBrains IDEs")
        vendor {
            name = "DarkHenos"
            url = "https://github.com/DarkHenos/claude-monitor-vault"
        }
        ideaVersion {
            sinceBuild = "231"
            untilBuild = provider { null }
        }
    }
    projectName = "claude-monitor-vault"
    // ./gradlew verifyPlugin: JetBrains' Plugin Verifier, against the floor
    // (2023.1, or the installed IDE) and a current release.
    pluginVerification {
        ides {
            val local = providers.gradleProperty("platformLocalPath").orNull
            if (local != null) local(file(local)) else ide("IC", providers.gradleProperty("platformVersion").get())
            providers.gradleProperty("verifyAlso").orNull?.let { ide("IC", it) }
        }
    }
    instrumentCode = false
    buildSearchableOptions = false
}

tasks {
    // The extension's own files, copied next to the plugin's jar. Node runs
    // them from there: the same files as the VS Code package, nothing rewritten.
    // Every sandbox gets them: the plugin's zip, runIde and the tests.
    withType<org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask> {
        from(extensionDir) {
            include("extension.js", "i18n.js", "package.json", "package.nls*.json", "LICENSE")
            include("l10n/*.json", "companion/*.js", "vault/*.js", "host/*.js")
            include("media/logo-companion.svg", "media/logo.svg", "media/activity-bar.svg")
            into(intellijPlatform.projectName.map { "$it/node" })
        }
    }

    // The tests start the real extension: a throwaway home keeps its vault,
    // ~/.claude and ~/.codex away from the developer's own.
    test {
        val home = layout.buildDirectory.dir("test-home").get().asFile
        doFirst { home.deleteRecursively(); home.mkdirs() }
        environment("USERPROFILE", home.path)
        environment("HOME", home.path)
        environment("CLAUDE_CONFIG_DIR", File(home, ".claude").path)
        environment("CODEX_HOME", File(home, ".codex").path)
    }

    // ./gradlew runIde -PopenProject=<folder> -PisolatedHome=<empty folder>
    // isolatedHome gives the extension a throwaway home: its own empty vault,
    // ~/.claude and ~/.codex, so a trial run touches nothing real.
    runIde {
        systemProperty("idea.trust.all.projects", "true")
        providers.gradleProperty("openProject").orNull?.let { args(it) }
        providers.gradleProperty("isolatedHome").orNull?.let { home ->
            environment("USERPROFILE", home)
            environment("HOME", home)
            environment("CLAUDE_CONFIG_DIR", "$home/.claude")
            environment("CODEX_HOME", "$home/.codex")
        }
    }
}
