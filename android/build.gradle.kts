buildscript {
    configurations.classpath {
        resolutionStrategy.eachDependency {
            when (requested.group) {
                "org.bouncycastle" -> useVersion("1.85")
                "io.netty" -> useVersion("4.1.137.Final")
                "org.apache.commons" -> if (requested.name == "commons-compress") useVersion("1.28.0")
                "org.bitbucket.b_c" -> if (requested.name == "jose4j") useVersion("0.9.6")
                "org.jdom" -> if (requested.name == "jdom2") useVersion("2.0.6.1")
            }
        }
    }
}

plugins {
    id("com.android.application") version "9.4.0" apply false
    id("org.jetbrains.kotlin.android") version "2.4.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.20" apply false
}

tasks.register("securityInventory") {
    doLast {
        fun coordinates(configuration: org.gradle.api.artifacts.Configuration, scope: String) =
            configuration.resolvedConfiguration.resolvedArtifacts.map {
                val id = it.moduleVersion.id
                mapOf("scope" to scope, "name" to "${id.group}:${id.name}", "version" to id.version)
            }
        val runtime = coordinates(project(":app").configurations.getByName("releaseRuntimeClasspath"), "runtime")
        val build = allprojects.flatMap { coordinates(it.buildscript.configurations.getByName("classpath"), "build") }
        val output = layout.buildDirectory.file("reports/security/dependencies.json").get().asFile
        output.parentFile.mkdirs()
        output.writeText(groovy.json.JsonOutput.toJson((runtime + build).distinct()))
    }
}
