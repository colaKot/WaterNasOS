package com.nascabos.tv

import android.content.Context
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.FragmentManager
import androidx.fragment.app.commit
import androidx.lifecycle.lifecycleScope
import com.google.gson.Gson
import com.nascabos.tv.core.api.ApiConfig
import com.nascabos.tv.core.api.ApiController
import com.nascabos.tv.core.api.AuthApiService
import com.nascabos.tv.core.api.p2p.P2pIcePreference
import com.nascabos.tv.core.i18n.LocaleManager
import com.nascabos.tv.core.ui.JwtSessionExpiredUi
import com.nascabos.tv.core.update.TvAppUpdate
import com.nascabos.tv.data.model.ServerInfo
import com.nascabos.tv.data.storage.ServerStore
import com.nascabos.tv.modules.music.MusicGroupGridFragment
import com.nascabos.tv.modules.music.MusicPlaylistGridFragment
import com.nascabos.tv.modules.music.MusicTrackGridFragment
import com.nascabos.tv.modules.photo.library.PhotoLibraryGridFragment
import com.nascabos.tv.modules.serverlist.HomeBrowseFragment
import com.nascabos.tv.modules.serverlist.ServerBrowseFragment
import com.nascabos.tv.modules.serverlist.resolveChannelForLogin
import com.nascabos.tv.modules.video.VideoGridFragment
import com.nascabos.tv.modules.video.VideoLibraryGridFragment
import com.nascabos.tv.modules.photo.timeline.PhotoTimelineBrowseFragment
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity(), AppHostActivity {
    private var loadingOverlay: View? = null
    private val gson = Gson()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        LocaleManager.init(applicationContext)
        LocaleManager.restoreSavedLanguage()
        ApiController.init(applicationContext)
        ApiController.setP2pRelayConnectedCallback { TvAppUpdate.check(this, 0L) }
        setContentView(R.layout.activity_main)
        loadingOverlay = findViewById(R.id.global_loading_overlay)

        // savedInstanceState != null 说明是 Activity 重建（Fragment 已由 FragmentManager 恢复），
        // 此时既不该重启登录流程，也不该重复弹升级。
        if (savedInstanceState == null) {
            supportFragmentManager.commit {
                replace(R.id.main_container, ServerBrowseFragment.newInstance())
            }
            window.decorView.post { TvAppUpdate.check(this) }
            lifecycleScope.launch { restoreSessionOrAutoLogin() }
        }
    }

    override fun onResume() {
        super.onResume()
        JwtSessionExpiredUi.attachResumedActivity(this)
    }

    override fun onDestroy() {
        JwtSessionExpiredUi.detachIfSame(this)
        super.onDestroy()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_UP) {
            val code = event.keyCode
            if (code == KeyEvent.KEYCODE_MENU || code == KeyEvent.KEYCODE_SETTINGS) {
                val current = supportFragmentManager.findFragmentById(R.id.main_container)
                if (current is HomeBrowseFragment) {
                    current.openSettingsFromActivity()
                    return true
                }
                if (current is VideoGridFragment) {
                    current.openOptionsFromActivity()
                    return true
                }
                if (current is VideoLibraryGridFragment) {
                    current.openOptionsFromActivity()
                    return true
                }
                if (current is PhotoTimelineBrowseFragment) {
                    current.openOptionsFromActivity()
                    return true
                }
                if (current is PhotoLibraryGridFragment) {
                    current.openOptionsFromActivity()
                    return true
                }
                if (current is MusicTrackGridFragment) {
                    current.openOptionsFromActivity()
                    return true
                }
                if (current is MusicGroupGridFragment) {
                    current.openOptionsFromActivity()
                    return true
                }
                if (current is MusicPlaylistGridFragment) {
                    current.openOptionsFromActivity()
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun setLoadingVisible(visible: Boolean) {
        loadingOverlay?.visibility = if (visible) View.VISIBLE else View.GONE
    }

    override fun showError(message: String) {
        if (isFinishing) return
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.error_title))
            .setMessage(message)
            .setPositiveButton(getString(R.string.action_ok), null)
            .show()
    }

    /**
     * 启动流程：能恢复会话就直进首页，不能则静默重登，最差退回服务器列表。
     *
     * 顺序（与 Flutter 主端 server_list_controller._tryAutoLogin 语义一致）：
     * ① 本地 accessToken 按 lastLoginTime + expiresIn 估算还没过期，且是直连地址 → 不发请求直接进首页；
     * ② 站点存了账号密码、且没勾「每次都要输入密码」且用户没主动登出过 → 静默重新登录；
     * ③ 兜底：只恢复连接通道，用户自己点服务器。
     *
     * 任何一步失败都静默（不弹错误框），因为用户此时看到的是服务器列表，点一下即可手动重来。
     */
    private suspend fun restoreSessionOrAutoLogin() {
        if (ApiController.baseUrl.trim().isNotEmpty()) return
        val store = ServerStore(applicationContext, gson)
        val last = runCatching { store.lastSelectedFlow.first() }.getOrNull() ?: return

        if (isLocalTokenFresh(last) && last.serverUrl.trim().isNotEmpty()) {
            // 直连地址可能已经变了（换网络/换 IP），先探一下再决定，避免进到一片空白的首页
            val directUrl = last.serverUrl.trim()
            val reachable =
                withContext(Dispatchers.IO) {
                    runCatching {
                        AuthApiService.checkServerStatus(directUrl, timeoutSeconds = 3)
                    }.getOrNull()?.let { it.success && it.isNasCabServer } == true
                }
            if (reachable) {
                ApiController.setBaseUrl(directUrl)
                ApiController.setTokens(
                    last.accessToken,
                    last.refreshToken,
                    last.accessTokenExpiresAtEpochSec.takeIf { it > 0L },
                    last.serverVersion.trim().takeIf { it.isNotEmpty() },
                )
                setAutoLoginEnabled(this, true)
                openHome()
                return
            }
        }

        if (isAutoLoginAllowed(last)) {
            val ok = silentLogin(last, store)
            if (ok) {
                openHome()
                return
            }
        }

        restoreChannelOnly(last)
    }

    /** 「记住我」：没被主动登出过 + 没勾每次输密码 + 本地有账号密码 */
    private fun isAutoLoginAllowed(server: ServerInfo): Boolean {
        if (isAutoLoginDisabled(this)) return false
        if (server.requirePasswordEveryLogin) return false
        if (server.username.trim().isEmpty()) return false
        if (server.password.trim().isEmpty()) return false
        return true
    }

    /**
     * 估算本地 token 是否还没过期。
     * ⚠️ ServerInfo.accessTokenExpiresAtEpochSec 实际存的是登录返回的 expiresIn（**相对秒数**），
     * 不是绝对时间戳，所以必须用 lastLoginTimeEpochMs 推算。
     */
    private fun isLocalTokenFresh(server: ServerInfo): Boolean {
        if (server.accessToken.trim().isEmpty()) return false
        val expiresInSec = server.accessTokenExpiresAtEpochSec
        if (expiresInSec <= 0L) return false
        val issuedAtMs = server.lastLoginTimeEpochMs
        if (issuedAtMs <= 0L) return false
        return issuedAtMs + expiresInSec * 1000L > System.currentTimeMillis() + 120_000L
    }

    private suspend fun silentLogin(server: ServerInfo, store: ServerStore): Boolean {
        // 局域网登录通常 100ms 内完成，超过 700ms 才显示遮罩，避免列表闪一下
        val loadingJob =
            lifecycleScope.launch {
                delay(700)
                setLoadingVisible(true)
            }
        return try {
            val result =
                withContext(Dispatchers.IO) {
                    val outcome = resolveChannelForLogin(server, ApiController.getDevConnectMode())
                    val resolved = outcome.resolved ?: return@withContext null
                    ApiController.setBaseUrl(resolved.baseUrl)
                    val login =
                        AuthApiService.loginToServer(
                            baseUrl = resolved.baseUrl,
                            serverInfo = resolved.serverForAuth,
                            appContext = applicationContext,
                        )
                    resolved.serverForAuth to login
                }
            if (result == null) return false
            val (authServer, login) = result
            if (!login.success) return false
            // 2FA 无法静默完成，交给用户从列表点进去手动走验证码
            if (login.twoFactorRequired == true) return false

            val updated = AuthApiService.applyLoginResult(authServer, login)
            store.upsert(updated)
            store.setLastSelected(updated)
            ApiController.setTokens(
                updated.accessToken,
                updated.refreshToken,
                updated.accessTokenExpiresAtEpochSec.takeIf { it > 0L },
                updated.serverVersion.trim().takeIf { it.isNotEmpty() },
            )
            setAutoLoginEnabled(this, true)
            true
        } catch (_: Throwable) {
            false
        } finally {
            loadingJob.cancel()
            setLoadingVisible(false)
        }
    }

    /** 只恢复连接通道（直连地址 / P2P 配对码），不尝试登录 */
    private suspend fun restoreChannelOnly(server: ServerInfo) {
        val direct = server.serverUrl.trim()
        if (direct.isNotEmpty()) {
            ApiController.setBaseUrl(direct)
            return
        }
        val code = server.pairCode.trim()
        if (code.isEmpty()) return
        val pref =
            when (ApiController.getDevConnectMode()) {
                ApiController.DevConnectMode.P2pDirect -> P2pIcePreference.DirectOnly
                ApiController.DevConnectMode.P2pRelay -> P2pIcePreference.RelayOnly
                else -> P2pIcePreference.Auto
            }
        runCatching { withContext(Dispatchers.IO) { ApiController.connectP2pByPairCode(code, icePreference = pref) } }
        if (ApiController.baseUrl.trim().isEmpty()) {
            ApiController.setBaseUrl(ApiConfig.p2pBaseUrl)
        }
    }

    private fun openHome() {
        if (isFinishing || isDestroyed) return
        val fm = supportFragmentManager
        fm.popBackStack(null, FragmentManager.POP_BACK_STACK_INCLUSIVE)
        fm.commit {
            setReorderingAllowed(true)
            replace(R.id.main_container, HomeBrowseFragment.newInstance())
        }
    }

    companion object {
        private const val PREFS_AUTH = "auth_prefs"

        /** 用户主动登出后置位，避免启动时被自动登回去（与 Flutter 主端同名 key 语义一致） */
        private const val KEY_AUTO_LOGIN_DISABLED = "auth_auto_login_disabled"

        fun isAutoLoginDisabled(context: Context): Boolean {
            return context.getSharedPreferences(PREFS_AUTH, Context.MODE_PRIVATE)
                .getBoolean(KEY_AUTO_LOGIN_DISABLED, false)
        }

        fun setAutoLoginEnabled(context: Context, enabled: Boolean) {
            context.getSharedPreferences(PREFS_AUTH, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_AUTO_LOGIN_DISABLED, !enabled)
                .apply()
        }
    }
}
