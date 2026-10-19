# ─────────────────────────────────────────────────────────────────────────────
# Flutter 3.27+ 起，`flutter build apk --release` 默认给 release 打开 R8
# （FlutterPlugin.kt 里 `releaseBuildType.isMinifyEnabled = true`）。
# 本文件会被 Flutter 的 gradle 插件自动纳入 proguardFiles（检测
# `<app模块>/proguard-rules.pro` 存在即加入），无需在 build.gradle 里手写。
#
# ⚠️ 三个 Android 端（flutter_client / photo_client / music_client）各有一份，
#    内容必须完全一致。改一处请同步另外两处。
# ─────────────────────────────────────────────────────────────────────────────
# 2026-10-18 真机事故（HONOR PTP-AN70 / Android 17，主端 1.1.0，两次踩坑）
#
# 坑 1（build 33）：启动卡在系统启动画面，连登录页都出不来。
#   NoSuchMethodError: no non-static method
#   "Lio/flutter/plugins/sharedpreferences/SharedPreferencesApiRegistrar;
#    .getAll(String,List,kotlin/coroutines/Continuation;)"
#   反编译确认方法实际被混淆成 getAll(String,List,Ln4/c;) —— R8 把
#   `kotlin.coroutines.Continuation` 重命名了，而 pigeon 生成的 @Keep 类只保住
#   自己的名字，签名里的第三方类型照样被改 ⇒ descriptor 对不上。
#
# 坑 2（build 35）：签名对上了，但换成了
#   ClassNotFoundException: Didn't find class "kotlin/Result"
#   实测该包里 kotlin.Result / kotlin.Unit / kotlin.ResultKt / kotlin.Pair
#   **全部不存在**：R8 把它们当成不可达代码整类删掉了。而 suspend 函数运行时
#   必须用 kotlin.Result 包装返回/异常 ⇒ 一调用就崩。
#   根因是 R8 在 Kotlin 2.2 的元数据下做了过度 shrink。
#
# 结论：R8 对这个项目的 Kotlin 运行时判断不可信，必须把整个 Kotlin 运行时
#       与协程库完整保留（体积代价约 1~2 MB，远小于一次崩溃的代价）。
# ─────────────────────────────────────────────────────────────────────────────

# ① Kotlin 运行时：全保留（stdlib 的 value class 会被 R8 误删，见坑 2）
-keep class kotlin.** { *; }
-keep interface kotlin.** { *; }
-dontwarn kotlin.**

# ② Kotlin 协程：全保留（suspend 函数的 Continuation / intrinsics 都在这，见坑 1）
-keep class kotlinx.** { *; }
-keep interface kotlinx.** { *; }
-dontwarn kotlinx.**

# ③ Flutter 插件：默认规则是 `-keep,allowshrinking,allowobfuscation`，
#    也就是"允许删除"。这里改成实打实保留，避免插件类被 shrink 掉。
-keep class io.flutter.plugins.** { *; }
-keep class io.flutter.plugin.** { *; }
-keep class io.flutter.view.** { *; }
-keep class io.flutter.embedding.** { *; }
-dontwarn io.flutter.**

# ④ pigeon 生成的消息通道类：类名由 @Keep 保住，但签名里的类型可能被混淆，
#    一并显式保留，防止坑 1 复发。
-keep class **.Messages$* { *; }
-keep class **.*ApiRegistrar { *; }
-keep class **.*PigeonCodec { *; }
-keep class **.*PigeonUtils { *; }
