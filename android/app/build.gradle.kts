plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.alaarab.mutter"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.alaarab.mutter"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    splits.abi {
        isEnable = true
        reset()
        include("arm64-v8a", "armeabi-v7a", "x86_64")
        isUniversalApk = true
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
        resources.merges += "META-INF/LICENSE.md"
    }
    sourceSets["main"].assets.srcDir("../../design/fonts")
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

val generateBrand by tasks.registering {
    val source = rootProject.file("../docs/brand/icon.svg")
    val output = layout.buildDirectory.dir("generated/brand/res")
    inputs.file(source)
    outputs.dir(output)
    doLast {
        val svg = source.readText()
        val path = Regex("<path d=\"([^\"]+)\"").find(svg)!!.groupValues[1]
        val ink = Regex("stroke=\"(#[A-Fa-f0-9]{6})\"/>").find(svg)!!.groupValues[1]
        val background =
            Regex("<rect width=\"512\" height=\"512\" fill=\"([^\"]+)\"").find(svg)!!.groupValues[1]
        fun resource(name: String, text: String) {
            output.get().file(name).asFile.apply {
                parentFile.mkdirs()
                writeText(text)
            }
        }
        resource(
            "drawable/brand_mark.xml",
            """<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="768" android:viewportHeight="768"><group android:translateX="128" android:translateY="128"><path android:pathData="$path" android:strokeColor="$ink" android:strokeWidth="54" android:strokeLineCap="butt" android:fillColor="@android:color/transparent" /></group></vector>""",
        )
        resource(
            "drawable/notification_mark.xml",
            """<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="512" android:viewportHeight="512"><path android:pathData="$path" android:strokeColor="#FFFFFF" android:strokeWidth="54" android:fillColor="@android:color/transparent" /></vector>""",
        )
        resource(
            "mipmap-anydpi/ic_launcher.xml",
            """<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/brand_background"/><foreground android:drawable="@drawable/brand_mark"/><monochrome android:drawable="@drawable/brand_mark"/></adaptive-icon>""",
        )
        resource(
            "values/brand.xml",
            """<resources><color name="brand_background">$background</color></resources>""",
        )
    }
}

android.sourceSets["main"].res.srcDir(layout.buildDirectory.dir("generated/brand/res"))

tasks.named("preBuild").configure { dependsOn(generateBrand) }

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.09.01"))
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("org.bouncycastle:bcpkix-jdk18on:1.85")
    implementation("io.github.webrtc-sdk:android:150.7871.01")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.09.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test:runner:1.7.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
