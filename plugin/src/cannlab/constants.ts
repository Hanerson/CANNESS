/**
 * Fixed endpoints and identifiers of the GitCode OAuth + CANNLab open API
 * chain. They mirror the AtomGit Dev Space extension and the `npussh` client
 * (https://gitcode.com/niuyuhu/cannlab-ssh), which is the reference
 * implementation this integration follows.
 *
 * The OAuth client id and the redirect URI are the official extension's own
 * public client: the CANNLab backend only accepts that pair, so the callback
 * port is fixed and cannot be chosen by us.
 */

/** Browser-facing authorization endpoint. */
export const GITCODE_AUTHORIZE_URL = 'https://gitcode.com/oauth/authorize'

/** Token endpoint used for both the code exchange and the refresh grant. */
export const GITCODE_TOKEN_URL = 'https://web-api.gitcode.com/score-proxy/api/v1/oauth/token'

/** GitCode user profile, used only to show who is signed in. */
export const GITCODE_USER_URL = 'https://api.gitcode.com/api/v5/user'

/** The official Dev Space extension's public OAuth client id. */
export const GITCODE_CLIENT_ID = '9a814f097c8a4ed38ce03f75c93f15f3'

/** OAuth requests carry this Referer, exactly as the official client does. */
export const GITCODE_REFERER = 'https://gitcode.com'

/** Fixed callback port: the registered redirect URI hard-codes it. */
export const CALLBACK_PORT = 3000

/** Fixed callback path of the registered redirect URI. */
export const CALLBACK_PATH = '/extension/callback'

/** Full registered redirect URI. */
export const CALLBACK_URI = `http://127.0.0.1:${String(CALLBACK_PORT)}${CALLBACK_PATH}`

/** How long one interactive sign-in may wait for the browser callback. */
export const OAUTH_TIMEOUT_MS = 5 * 60 * 1000

/**
 * How long the callback listener stays up after a successful sign-in.
 *
 * The tab GitCode redirected is still open on the user's machine. Closing the
 * listener the instant the code arrives means a reload, a restored session or a
 * second tab meets `ERR_CONNECTION_REFUSED` on a port that has nothing to do
 * with them any more. For this window a repeat callback is answered with a page
 * that says the sign-in already succeeded. A new sign-in preempts the window,
 * so it never turns into "port 3000 is busy".
 */
export const CALLBACK_GRACE_MS = 20 * 1000

/** CANNLab open API origin (a GitCode proxy in front of the Dev Container service). */
export const CANNLAB_API_BASE = 'https://dev.gitcode.com/api/v1/proxy/vscode'

/** Path prefix of the development-environment ("devenv") endpoints. */
export const CANNLAB_DEVENV_PATH = '/DevContainerService/open-api-inner/v1/devenv'

/** VSIX that ships the official port-forwarding helper. */
export const DEVSPACE_VSIX_URL
  = 'https://marketplace.visualstudio.com/_apis/public/gallery/publishers/atomgit-extensions/vsextensions/atomgitdevspace/latest/vspackage'

/** Path of the forwarding helper inside the unpacked VSIX. */
export const HELPER_RELATIVE_PATH = 'extension/dist/src/helper/port-forward-hub.js'

/** Relative path of the VSIX manifest inside the unpacked archive. */
export const HELPER_PACKAGE_RELATIVE_PATH = 'extension/package.json'

/** The instance status that means "running" in the CANNLab list API. */
export const STATUS_RUNNING = 2

/** Remote port the tunnel exposes: ordinary SSH. */
export const SSH_REMOTE_PORT = 22

/** Loopback host every tunnel endpoint binds to. */
export const LOOPBACK = '127.0.0.1'

/** Default credential reference holding the GitCode refresh token. */
export const DEFAULT_TOKEN_REF = 'CANNLAB_GITCODE_TOKEN'

/** The helper exits after ten idle minutes; keep it warm while a tunnel is open. */
export const HELPER_HEARTBEAT_MS = 30_000
