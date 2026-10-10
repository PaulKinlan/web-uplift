#!/usr/bin/env node
// SUITE CONVENTION, learned the expensive way (web-uplift-17o): a test that needs a local
// server must drive the CLI IN-PROCESS via gather() - NOT by running the CLI as a child with
// an in-process server. spawnSync blocks the parent's event loop, so the in-process server
// never answers the child's browser (observed directly: zero server hits and a 30s timeout
// on a HEALTHY page, for trace and dom alike). Worse, that failure mode MIMICS a starvation
// defect: a healthy page simply times out, indistinguishable from the behaviour under test,
// so a harness built that way cannot observe the behaviour it exists to check. The --out
// argument-validation tests are the exception: they exit before any browser launches, so a
// child run with an in-process server is safe there.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFilterArgs, repoRoot, tmp } from "./test-helpers.mjs";

import {
  testPreNavigationEmulation,
  testAxePrimitiveBypassesStrictCsp,
  testAxeKeepsPagePolicyAndDisclosesInjectionBypass,
  testThrottlingConditions,
  testLocaleTimezoneConditions,
  testConsoleEvidence,
  testConsoleEvidenceRedaction,
  testConsoleInteractDeadlineValidation,
  testHeadersPrimitiveFindsHeadersRegardlessOfNameCase,
  testHeadersPrimitiveSurvivesSlowResponseUnderLoad,
  testHarReadsRequestContentTypeAndRedirectLocationRegardlessOfCase,
  testHarRedirects,
  testHarWaitsForPendingResponses,
  testTrackersThirdPartySuffix,
  testEvidenceTruncationReporting,
  testFeaturesPrimitive,
  testDiscoverabilityHelpers,
  testDiscoverabilityH1InRaw,
  testTargetsPrimitive,
  testResiliencePrimitive,
  testResilienceWaitsForLateServiceWorkerRegistration,
  testA11yTreePrimitive,
  testAwaitCensus,
  testNoSourceArgumentOmitsSource,
  testAdversarialPageCannotInfluenceSource,
  testExplicitSourceHonoursOperatorSpecifiedRoot,
} from "./evidence.test.mjs";

import {
  testRedactHeaderList,
  testCredentialRedactionHelpers,
  testHarCredentialRedaction,
  testHarRedactsCredentialHeaders,
  testSecretsScanHandlesQuotedScriptUrl,
  testSecretsExternalScriptFetchIsCappedAndDeadlined,
  testSecretsArtifactDoesNotPersistMatches,
  testSecretsScanDoesNotPersistMatchCharacters,
  testSecretsCoverageClassification,
  testSourceTreeRedactsBeforeInlining,
  testDomSourceArtifactIsRedacted,
  testLogUrlRedaction,
  testCredentialRedactorsAgree,
} from "./redaction.test.mjs";

import {
  testCdpEndpointExposure,
  testCdpPipeTransport,
  testSilentPipeReadinessIsBounded,
  testClosedPipeRejectsPendingSends,
  testPipeReadinessThenExitFailsTheLaunch,
  testChromeCandidateDiscovery,
  testLaunchRetryAndDiagnostics,
  testChromeSandboxPolicy,
  testCdpDeadline,
  testLaunchAttributionForHungPrimitive,
  testOperatorLaunchAttribution,
  testLaunchSessionLoop,
  testNoOrphanBrowser,
  testCommittedProbeIsInert,
  testCommittedSiblingProbesAreInert,
} from "./chrome-cdp.test.mjs";

import {
  testMwgDriftExtractPipe,
  testMwgDriftBasisFloor,
  testGuidanceUsage,
  testGuidanceVersionPinnedInDocs,
  testMwgCatalogRegenerateAgreement,
  testPrinciplesMwgCatalogSyncAndChangedGuidance,
  testMwgDriftCheckGuard,
  testMwgArtefactGuard,
  testMwgDriftClassifierGuard,
  testMwgCatalogExtract,
  testBaselineOracle,
} from "./mwg-principles.test.mjs";

import {
  testCdpCopySyncGuard,
  testCdpCopySyncMutationGuard,
  testInstalledEvidenceCli,
  testNpxCacheDoesNotAccumulate,
  testInstalledTreeRelativeImportsResolve,
  testUpdateDryRunReadsInstallManifest,
  testCachedUpdateWarning,
  testUpdateCheckIsOptInAndUntrusted,
  testInstallSurfaceMatchesWhatInstallVendors,
  testInstallSkipsSymlinksInVendoredSource,
  testInstallCopyDepthGuard,
  testInstallVendorsCompleteClosure,
  testInstallRefusesDestinationSymlinks,
  testInstallNormalDestinationWrites,
  testMcpSkillsServerStdio,
} from "./install-package.test.mjs";

import {
  testHeadlessAllowlistIsScoped,
  testHeadlessAllowlistMatchesSkillContract,
  testSkillWriteContractGuard,
  testAgentChildEnvAllowlist,
  testBatchIsolationGate,
  testBatchDryRunUsesRetainedDirs,
  testBatchFlowDryRun,
  testFixSurvivesUnscoreableReports,
  testFixRefusesPassOnIncompleteCoverage,
  testFixRefusesContradictoryCoverageClaim,
  testFixRejectsMalformedReports,
  testFixWriteScopeDiffing,
  testFixModeRefusesOutOfScopeWrites,
  testFixModeScopeEdgeCases,
  testFixIsolationAssertion,
  testFixIsolatedRunPublishes,
  testSnapshotRunStructure,
  testSnapshotRunCopiesArtifacts,
  testSnapshotRunMissingArtifactsBestEffort,
  testSnapshotRunCopyErrorTolerance,
  testBatchWriteScope,
  testBatchResumeIsolation,
  testWriteScopeCoversExecutedTrees,
  testBatchIntegrityGateAbortsOnTamperedExecutedTree,
  testFlowNormalize,
  testFlowRecordSensitiveRedaction,
  testFlowReplayMutationGate,
  testFlowPierceShadowRootBrowser,
} from "./runner-agents.test.mjs";

import {
  testSyntaxChecks,
  testPackageRootImportIsSideEffectFree,
  testIconSatisfiesMatrix,
  testFirstPartyHostMatrix,
  testPageDerivedFetchGuard,
  testSafeFetchRedirectAndSizeGuard,
  testSafeFetchDnsRebindingGuard,
  testSafeFetchContentDecoding,
  testSchemaValidation,
  testAtomicCoverageValidator,
  testFetchDeadlineAndRawComparison,
  testScorecardRejectsEscapingComparisonRunIds,
  testScorecardReservesImageBoxes,
  testReservedImageBoxInBrowser,
  testLatestPointerCannotEscapeTheRunRoot,
  testSourceTreeSkipsSymlinkFileEscape,
  testSourceTreeSkipsSymlinkDirEscape,
  testSourceTreeSkipsSymlinkCycle,
  testSourceTreeDepthGuard,
  testCompareReportsUnconcludedChecks,
  testScorecardScoringAndRender,
  testScorecardArtifactContainment,
  testCompareArtifactContainment,
} from "./syntax-core.test.mjs";


export const ALL_TESTS = [
  testPreNavigationEmulation,
  testAxePrimitiveBypassesStrictCsp,
  testAxeKeepsPagePolicyAndDisclosesInjectionBypass,
  testThrottlingConditions,
  testLocaleTimezoneConditions,
  testConsoleEvidence,
  testConsoleEvidenceRedaction,
  testConsoleInteractDeadlineValidation,
  testHeadersPrimitiveFindsHeadersRegardlessOfNameCase,
  testHeadersPrimitiveSurvivesSlowResponseUnderLoad,
  testHarReadsRequestContentTypeAndRedirectLocationRegardlessOfCase,
  testHarRedirects,
  testHarWaitsForPendingResponses,
  testTrackersThirdPartySuffix,
  testEvidenceTruncationReporting,
  testFeaturesPrimitive,
  testDiscoverabilityHelpers,
  testDiscoverabilityH1InRaw,
  testTargetsPrimitive,
  testResiliencePrimitive,
  testResilienceWaitsForLateServiceWorkerRegistration,
  testA11yTreePrimitive,
  testAwaitCensus,
  testNoSourceArgumentOmitsSource,
  testAdversarialPageCannotInfluenceSource,
  testExplicitSourceHonoursOperatorSpecifiedRoot,
  testRedactHeaderList,
  testCredentialRedactionHelpers,
  testHarCredentialRedaction,
  testHarRedactsCredentialHeaders,
  testSecretsScanHandlesQuotedScriptUrl,
  testSecretsExternalScriptFetchIsCappedAndDeadlined,
  testSecretsArtifactDoesNotPersistMatches,
  testSecretsScanDoesNotPersistMatchCharacters,
  testSecretsCoverageClassification,
  testSourceTreeRedactsBeforeInlining,
  testDomSourceArtifactIsRedacted,
  testLogUrlRedaction,
  testCredentialRedactorsAgree,
  testCdpEndpointExposure,
  testCdpPipeTransport,
  testSilentPipeReadinessIsBounded,
  testClosedPipeRejectsPendingSends,
  testPipeReadinessThenExitFailsTheLaunch,
  testChromeCandidateDiscovery,
  testLaunchRetryAndDiagnostics,
  testChromeSandboxPolicy,
  testCdpDeadline,
  testLaunchAttributionForHungPrimitive,
  testOperatorLaunchAttribution,
  testLaunchSessionLoop,
  testNoOrphanBrowser,
  testCommittedProbeIsInert,
  testCommittedSiblingProbesAreInert,
  testMwgDriftExtractPipe,
  testMwgDriftBasisFloor,
  testGuidanceUsage,
  testGuidanceVersionPinnedInDocs,
  testMwgCatalogRegenerateAgreement,
  testPrinciplesMwgCatalogSyncAndChangedGuidance,
  testMwgDriftCheckGuard,
  testMwgArtefactGuard,
  testMwgDriftClassifierGuard,
  testMwgCatalogExtract,
  testBaselineOracle,
  testCdpCopySyncGuard,
  testCdpCopySyncMutationGuard,
  testInstalledEvidenceCli,
  testNpxCacheDoesNotAccumulate,
  testInstalledTreeRelativeImportsResolve,
  testUpdateDryRunReadsInstallManifest,
  testCachedUpdateWarning,
  testUpdateCheckIsOptInAndUntrusted,
  testInstallSurfaceMatchesWhatInstallVendors,
  testInstallSkipsSymlinksInVendoredSource,
  testInstallCopyDepthGuard,
  testInstallVendorsCompleteClosure,
  testInstallRefusesDestinationSymlinks,
  testInstallNormalDestinationWrites,
  testMcpSkillsServerStdio,
  testHeadlessAllowlistIsScoped,
  testHeadlessAllowlistMatchesSkillContract,
  testSkillWriteContractGuard,
  testAgentChildEnvAllowlist,
  testBatchIsolationGate,
  testBatchDryRunUsesRetainedDirs,
  testBatchFlowDryRun,
  testFixSurvivesUnscoreableReports,
  testFixRefusesPassOnIncompleteCoverage,
  testFixRefusesContradictoryCoverageClaim,
  testFixRejectsMalformedReports,
  testFixWriteScopeDiffing,
  testFixModeRefusesOutOfScopeWrites,
  testFixModeScopeEdgeCases,
  testFixIsolationAssertion,
  testFixIsolatedRunPublishes,
  testSnapshotRunStructure,
  testSnapshotRunCopiesArtifacts,
  testSnapshotRunMissingArtifactsBestEffort,
  testSnapshotRunCopyErrorTolerance,
  testBatchWriteScope,
  testBatchResumeIsolation,
  testWriteScopeCoversExecutedTrees,
  testBatchIntegrityGateAbortsOnTamperedExecutedTree,
  testFlowNormalize,
  testFlowRecordSensitiveRedaction,
  testFlowReplayMutationGate,
  testFlowPierceShadowRootBrowser,
  testSyntaxChecks,
  testPackageRootImportIsSideEffectFree,
  testIconSatisfiesMatrix,
  testFirstPartyHostMatrix,
  testPageDerivedFetchGuard,
  testSafeFetchRedirectAndSizeGuard,
  testSafeFetchDnsRebindingGuard,
  testSafeFetchContentDecoding,
  testSchemaValidation,
  testAtomicCoverageValidator,
  testFetchDeadlineAndRawComparison,
  testScorecardRejectsEscapingComparisonRunIds,
  testScorecardReservesImageBoxes,
  testReservedImageBoxInBrowser,
  testLatestPointerCannotEscapeTheRunRoot,
  testSourceTreeSkipsSymlinkFileEscape,
  testSourceTreeSkipsSymlinkDirEscape,
  testSourceTreeSkipsSymlinkCycle,
  testSourceTreeDepthGuard,
  testCompareReportsUnconcludedChecks,
  testScorecardScoringAndRender,
  testScorecardArtifactContainment,
  testCompareArtifactContainment,
];

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const { filters: testFilters, list: listTests } = parseFilterArgs(process.argv.slice(2));

  if (listTests) {
    for (const fn of ALL_TESTS) {
      console.log(fn.name);
    }
    process.exit(0);
  }

  const selectedTests = testFilters.length === 0
    ? ALL_TESTS
    : ALL_TESTS.filter((fn) =>
        testFilters.some((f) => fn.name.toLowerCase().includes(f.toLowerCase()))
      );

  if (selectedTests.length === 0) {
    console.error(`no tests matched filter: ${testFilters.join(", ")}`);
    process.exit(1);
  }

  for (const testFn of selectedTests) {
    await testFn();
  }
  if (selectedTests.length < ALL_TESTS.length) {
    console.log(`ran ${selectedTests.length}/${ALL_TESTS.length} tests matching [${testFilters.join(", ")}]: OK`);
  }
  console.log("tests OK");
}
