import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// Default headless address; override in wearos/local.properties or from adb at runtime.
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
val headlessHost = localProperties.getProperty("wearmux.host", "192.168.1.100")
val headlessPort = localProperties.getProperty("wearmux.port", "8765").toInt()

android {
    namespace = "com.wearmux.headless.wear"
    compileSdk {
        version = release(36)
    }

    defaultConfig {
        applicationId = "com.wearmux.headless.wear"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "HEADLESS_HOST", "\"$headlessHost\"")
        buildConfigField("int", "HEADLESS_PORT", headlessPort.toString())
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.wear.compose.material)
    implementation(libs.androidx.wear.compose.foundation)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
}
