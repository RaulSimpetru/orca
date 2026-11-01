import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import type { PrSidebarState } from '../session/mobile-pr-sidebar-state'
import type { MobilePrSidebarController } from '../session/use-mobile-pr-sidebar-controller'
import {
  useMobilePrTab,
  type MobilePrCreateSettled,
  type PrTabScreen
} from '../components/pr-sidebar/use-mobile-pr-tab'
import { usePrTabMenuGroups } from '../components/pr-sidebar/use-pr-tab-menu'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import type { SourceControlHubTab } from './mobile-source-control-hub-tab'

type Args = {
  state: MobileSourceControlState
  activeTab: SourceControlHubTab
  worktreeId: string
  prController: MobilePrSidebarController
  prBranch: string | null
  prHeadSha: string | null
  ready: boolean
  selectTab: (tab: SourceControlHubTab) => void
  onRefresh: () => void
  /** Changes-tab Create PR entries reach the PR tab's one sheet through this. */
  openCreatePrRef: MutableRefObject<() => void>
}

// The hub's wiring of the PR tab: its state, Create PR follow-through, pushed screens and ⋯ menu.
export function useMobileSourceControlPrTab({
  state,
  activeTab,
  worktreeId,
  prController,
  prBranch,
  prHeadSha,
  ready,
  selectTab,
  onRefresh,
  openCreatePrRef
}: Args) {
  const t = useMobileTranslation()
  const { client, connState, status, worktreeLabel, loadStatus, branchCompareResult } = state
  const isHostedRepo = prController.prSidebarIsGithubRepo
  const refetchPr = prController.refetchPRSidebar
  // Mid-probe false is still loading; do not flash unavailable.
  const prTabState: PrSidebarState = !(ready && prController.prSidebarRepoProbeLoaded)
    ? { kind: 'loading' }
    : !isHostedRepo
      ? {
          kind: 'blocked',
          message: t(
            'pullRequest.prViewPanel.providerUnavailable',
            'Hosted review panel unavailable for this provider.'
          )
        }
      : prBranch === null
        ? {
            kind: 'error',
            message: t('pullRequest.prViewPanel.branchUnavailable', 'Current branch unavailable.')
          }
        : prController.prSidebarState
  // Checks and Comments push over the hub; the hub pager takes this over once it lands.
  const [prScreen, setPrScreen] = useState<PrTabScreen | null>(null)
  const commitMessageRef = useRef(state.commitMessage)
  useLayoutEffect(() => {
    commitMessageRef.current = state.commitMessage
  })
  const { setCommitMessage, setCreatedPrUrl, setCreatedPrWarning, cancelGenerateCommitMessage } =
    state
  const onCreateSettled = useCallback(
    ({ created, committed }: MobilePrCreateSettled) => {
      // The run may commit before push or create fails; the composer and Changes must catch up either way.
      if (committed) {
        setCommitMessage('')
      }
      void loadStatus({ preserveReadyOnFailure: true, force: true })
      if (!created) {
        return
      }
      // Only GitHub has a PR tab; other providers keep today's Created notice with its Open link.
      if (created.provider === 'github' && isHostedRepo) {
        void refetchPr({ includeDetails: true })
        selectTab('pr')
        // "Created, but not refreshed" or "already open" still needs saying, with its link.
        if (!created.warning) {
          return
        }
      }
      setCreatedPrUrl(created.url)
      setCreatedPrWarning(created.warning)
    },
    [
      isHostedRepo,
      loadStatus,
      refetchPr,
      selectTab,
      setCommitMessage,
      setCreatedPrUrl,
      setCreatedPrWarning
    ]
  )
  const prTab = useMobilePrTab({
    // Comments keep their threads fresh; the tab and Checks need only the PR and its checks.
    live: prScreen === 'comments' ? 'details' : prScreen || activeTab === 'pr' ? 'checks' : false,
    state: prTabState,
    refetch: refetchPr,
    client,
    connState,
    worktreeId,
    gitBranch: prBranch,
    gitStatus: status,
    headSha: prHeadSha,
    workspaceLabel: worktreeLabel,
    onOpenScreen: setPrScreen,
    commitsAhead: branchCompareResult?.summary.commitsAhead ?? null,
    readCommitMessage: () => commitMessageRef.current,
    beforeCreate: cancelGenerateCommitMessage,
    onCreateSettled
  })
  useLayoutEffect(() => {
    openCreatePrRef.current = prTab.openCreatePrSheet
  })
  const prMenuGroups = usePrTabMenuGroups(prTab, onRefresh)
  useBackClaim(
    prScreen
      ? () => {
          setPrScreen(null)
          return true
        }
      : null
  )

  const summary = branchCompareResult?.summary
  const branchCompare =
    summary?.status === 'ready'
      ? { commitsAhead: summary.commitsAhead, baseRef: summary.baseRef }
      : null
  return { prTab, prScreen, setPrScreen, prMenuGroups, branchCompare }
}
