import { NgModule, Injectable } from '@angular/core'
import { AppService, BaseTabComponent, LogService, Logger } from 'tabby-core'

type CloseTabFn = (tab: BaseTabComponent, checkCanClose?: boolean, ignorePinned?: boolean) => Promise<void>

interface SessionLike {
    kill?: (signal?: string) => void
    gracefullyKillProcess?: () => Promise<void>
}

interface TerminalLikeTab extends BaseTabComponent {
    sendInput?: (data: string | Buffer) => void
    profile?: { type?: string; name?: string }
    effectivelyPinned?: boolean
    session?: SessionLike
}

interface SplitLikeTab extends BaseTabComponent {
    getAllTabs?: () => BaseTabComponent[]
    getFocusedTab?: () => BaseTabComponent | null
}

/** How long to wait for the fast close to take effect before falling back. */
const EXIT_TIMEOUT_MS = 500

/** Only these profile types get the fast close treatment. */
const FAST_CLOSE_PROFILE_TYPES = new Set<string>(['local'])

function isLocalShell (tab: BaseTabComponent): boolean {
    const t = tab as TerminalLikeTab
    const type = t.profile?.type
    return (
        typeof t.sendInput === 'function' &&
        typeof type === 'string' &&
        FAST_CLOSE_PROFILE_TYPES.has(type)
    )
}

/** Result of preparing one local shell for a fast close. */
interface FastTarget {
    tab: TerminalLikeTab
    restoreGKP: () => void
}

/** Patch one local shell session's graceful-kill to the fast (SSH-style) version. */
function prepareFastTarget (tab: BaseTabComponent): FastTarget | null {
    const terminalTab = tab as TerminalLikeTab
    if (!isLocalShell(tab)) {
        return null
    }
    const session = terminalTab.session
    const originalGKP = session?.gracefullyKillProcess
        ? session.gracefullyKillProcess.bind(session)
        : undefined
    let patched = false
    if (session && originalGKP) {
        try {
            session.gracefullyKillProcess = async () => {
                try { session.kill?.('SIGTERM') } catch (_e) { /* gone */ }
            }
            patched = true
        } catch (_e) { /* leave original */ }
    }
    return {
        tab: terminalTab,
        restoreGKP: () => {
            if (patched && session && originalGKP) {
                try { session.gracefullyKillProcess = originalGKP } catch (_e) { /* noop */ }
            }
        },
    }
}

/**
 * Close the local shell WITHOUT writing a command into its history.
 *
 * - Ctrl-U (\x15) clears any half-typed line (so the following EOF is taken as
 *   end-of-input rather than a "delete char under cursor").
 * - Ctrl-D (\x04) delivers EOF; zsh/bash exit cleanly on EOF at an empty prompt.
 *
 * This drives the exact same pty 'exit' -> session.destroy() -> tab removal ->
 * split collapse chain that typing `exit` did, but sends only control
 * characters — nothing is ever recorded in shell history.
 */
function fastKill (target: FastTarget): void {
    try {
        target.tab.sendInput!('\x15')  // Ctrl-U: kill current line
        target.tab.sendInput!('\x04')  // Ctrl-D: EOF -> shell exits cleanly
    } catch (_e) {
        target.restoreGKP()
    }
}

/**
 * Wraps AppService.closeTab so that closing LOCAL shell tab(s) sends EOF to the
 * shell — exiting it cleanly without typing a command — instead of running
 * Tabby's slow close path (child-process enumeration + full terminal state
 * serialization + a hard-coded 500ms wait). Nothing enters command history.
 *
 * Handles both plain terminal tabs and SplitTabComponent wrappers (Tabby 1.x
 * wraps even a single pane in a SplitTab). For a split, ALL child tabs must be
 * local shells for the fast path to apply; otherwise it falls back to the
 * original logic so SSH/serial panes keep their correct close behaviour.
 */
@Injectable()
export class FastCloseService {
    private static installed = false
    private logger: Logger

    constructor (app: AppService, log: LogService) {
        this.logger = log.create('fast-close')

        if (FastCloseService.installed) {
            return
        }
        FastCloseService.installed = true

        const original = app.closeTab.bind(app) as CloseTabFn
        const logger = this.logger

        app.closeTab = async (
            tab: BaseTabComponent,
            checkCanClose = true,
            ignorePinned = false,
        ): Promise<void> => {
            const t = tab as any
            const pinned = t.effectivelyPinned ?? t.pinned

            if (!checkCanClose || pinned) {
                return original(tab, checkCanClose, ignorePinned)
            }

            const split = tab as SplitLikeTab
            let targets: FastTarget[] = []

            if (typeof split.getAllTabs === 'function') {
                // SplitTab wrapper: fast path only if every child is a local shell.
                const children = split.getAllTabs() ?? []
                if (children.length > 0 && children.every(c => isLocalShell(c))) {
                    targets = children
                        .map(c => prepareFastTarget(c))
                        .filter((x): x is FastTarget => !!x)
                } else {
                    return original(tab, checkCanClose, ignorePinned)
                }
            } else if (isLocalShell(tab)) {
                targets = [prepareFastTarget(tab)!]
            } else {
                return original(tab, checkCanClose, ignorePinned)
            }

            if (!targets.length) {
                return original(tab, checkCanClose, ignorePinned)
            }

            const started = Date.now()
            for (const target of targets) {
                fastKill(target)
            }

            // Fall back to native close only if the tab survives past the timeout
            // (e.g. shell configured with `ignoreeof`, or EOF was swallowed).
            const poll = setInterval(() => {
                if (!app.tabs.includes(tab)) {
                    clearInterval(poll)
                    return
                }
                if (Date.now() - started >= EXIT_TIMEOUT_MS) {
                    clearInterval(poll)
                    for (const target of targets) { target.restoreGKP() }
                    logger.debug('fast close timed out, falling back')
                    void original(tab, checkCanClose, ignorePinned)
                }
            }, 25)

            return
        }

        console.log('[tabby-fast-close] installed: Cmd+W now closes local shells instantly')
        logger.info('installed: Cmd+W now closes local shells instantly')
    }
}

@NgModule({
    providers: [
        FastCloseService,
    ],
})
export default class FastCloseModule {
    constructor (_fastClose: FastCloseService) { /* no-op */ }
}
