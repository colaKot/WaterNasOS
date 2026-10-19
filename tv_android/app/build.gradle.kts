plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.nascabos.tv"
    compileSdk = 36

    sourceSets {
        named("main") {
            assets.srcDirs("src/main/assets")
        }
    }

    defaultConfig {
        applicationId = "com.nascabos.tv"
        minSdk = 23
        targetSdk = 36
        // 2026-10-18：修复「不自动登录 / 无权限应用仍显示 / 封面全空白」+ 升级渠道校验
        // ⚠️ 线上已存在 1.1.0（versionCode=10，CN=nascabos 签名），所以这里必须 >1.1.0 / >10，
        //    否则每次启动仍会提示升级到 1.1.0
        versionCode = 20
        versionName = "2.0.0"
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_11.toString()
    }

    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.fragment:fragment-ktx:1.8.5")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")

    implementation("androidx.leanback:leanback:1.0.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.media3:media3-exoplayer:1.10.0")
    implementation("androidx.media3:media3-exoplayer-hls:1.10.0")
    implementation("androidx.media3:media3-ui:1.10.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    implementation("com.google.code.gson:gson:2.11.0")
    implementation("androidx.datastore:datastore-preferences:1.1.2")

    implementation("com.qianwen:update-app:3.5.2")
    implementation("com.qianwen:update-app-kotlin:1.2.3")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")

    implementation("org.webrtc:google-webrtc:1.0.32006")

    implementation("org.videolan.android:libvlc-all:3.5.1")
    implementation(files("libs/lib-decoder-ffmpeg-release.aar"))
}
