# fonts_fallback —— Flutter Web 的 Noto 回退字体镜像

Flutter Web（CanvasKit）不带中日韩字形，缺字形时引擎会去 `fontFallbackBaseUrl`
（默认 `https://fonts.gstatic.com/s/`）现拉 Noto。NAS 在内网 / 客户端连不上 gstatic
时拉不到，于是中文显示成「方块里一个 X」的豆腐块。

`web/index.html` 已把 `fontFallbackBaseUrl` 指到 `fonts_fallback/s/`，本目录就是那份镜像。
文件路径与 `flutter/bin/cache/flutter_web_sdk/lib/_engine/engine/font_fallback_data.dart`
里登记的相对路径**一字不差**（`<family>/<version>/<hash>.<n>.woff2`）。

重新生成（升级 Flutter SDK 后必做，URL 带版本和内容哈希）：

```
python tool/fetch_fallback_fonts.py --clean
```

只缺部分就 `python tool/fetch_fallback_fonts.py`（默认跳过已存在）。
