package com.nascabos.tv.core.api

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * 读取服务端下发的「可用应用」清单。
 *
 * 服务端 `GET /api/apps/getApps` 返回的 all_app 已经过两层过滤：
 * ① `normalUserNoShowApps`（普通用户固定不显示的应用）；
 * ② `userAllowedApps`（超级管理员给子账号配的应用白名单，没配就不限制）。
 *
 * ⚠️ 别再自己在前端硬编码「普通用户能看哪些应用」——服务端才是唯一真源，
 * 否则改一次权限就要发一次版。
 */
object AppsApiService {
    private fun authHeaders(): Map<String, String> {
        val token = ApiController.accessToken.trim()
        if (token.isEmpty()) return emptyMap()
        return mapOf("Authorization" to "Bearer $token")
    }

    /** 网络异常/未登录返回 null（调用方按「不限制」处理，避免误伤） */
    suspend fun fetchAllowedApps(timeoutSeconds: Long = 8): List<String>? {
        return try {
            val raw =
                ApiController.requestJsonMap(
                    baseUrl = ApiController.baseUrl,
                    path = "/api/apps/getApps",
                    timeoutSeconds = timeoutSeconds,
                    headers = authHeaders(),
                )
            val ok = raw["success"] as? Boolean ?: true
            if (!ok) return null
            val data = raw["data"] as? Map<*, *> ?: return null
            val list = (data["all_app"] ?: data["allApp"]) as? List<*> ?: return null
            list.mapNotNull { it?.toString()?.trim()?.takeIf { v -> v.isNotEmpty() } }
        } catch (_: Throwable) {
            null
        }
    }
}

/**
 * 当前账号可用应用的内存缓存（进程内）。
 *
 * 语义：[allowedApps] 为 null 表示「还不知道」——此时所有入口都显示，
 * 等 [refresh] 拿到服务端结果后再按结果裁剪。这样网络抖动不会把相册/音乐入口整块吞掉。
 */
object AppAccessStore {
    private val _allowedApps = MutableStateFlow<Set<String>?>(null)
    val allowedApps: StateFlow<Set<String>?> = _allowedApps.asStateFlow()

    /** appKey 与服务端 config.defaultApps 一致：folder / photo / movie / music / book ... */
    fun allows(appKey: String): Boolean {
        val allowed = _allowedApps.value ?: return true
        return allowed.contains(appKey)
    }

    suspend fun refresh() {
        val remote = AppsApiService.fetchAllowedApps() ?: return
        _allowedApps.value = remote.toSet()
    }

    fun clear() {
        _allowedApps.value = null
    }
}
