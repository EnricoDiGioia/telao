plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Número da versão = número do build no GitHub (cada atualização instala por cima da anterior)
val buildNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
// Endereço do Telão já embutido no app (variável TELAO_URL do repositório no GitHub)
val defaultServer = (System.getenv("TELAO_URL") ?: "").trim().trimEnd('/')

android {
    namespace = "app.telao"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.telao"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
        buildConfigField("String", "DEFAULT_SERVER", "\"$defaultServer\"")
    }

    // Assinatura: a chave vem dos segredos do GitHub (nunca fica no repositório).
    // Com a mesma chave em todo build, a atualização instala por cima sem desinstalar.
    // Sem os segredos, o build usa uma chave temporária (funciona, mas cada versão
    // nova exige desinstalar a anterior).
    val keystorePath = System.getenv("TELAO_KEYSTORE_FILE")
    val keystorePass = System.getenv("TELAO_KEYSTORE_PASSWORD")
    val hasKey = !keystorePath.isNullOrBlank() && !keystorePass.isNullOrBlank() && file(keystorePath).exists()

    signingConfigs {
        if (hasKey) {
            create("shared") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePass
                keyAlias = "telao"
                keyPassword = keystorePass
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (hasKey) signingConfigs.getByName("shared") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("io.getstream:stream-webrtc-android:1.3.9")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.core:core-ktx:1.13.1")
}
