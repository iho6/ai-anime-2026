"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import {
  apiHubDelete,
  apiNewCharacterDiscard,
  apiNewCharacterDraftBases,
} from "../../lib/api";
import { HomeIcon, SquareIconButton, TriangleIcon } from "../../components/IconPrimitives";
import { HfTokenSettingsButton } from "../../components/HfTokenSettingsButton";
import { useAppError } from "../../components/ErrorProvider";
import { BaseCloseupWizardModal } from "../../components/BaseCloseupWizardModal";
import { NewCharacterCreatePanel } from "../../components/create/NewCharacterCreatePanel";

export default function NewCharacterPage() {
  const router = useRouter();
  const { showError } = useAppError();

  const [closeupWizardOpen, setCloseupWizardOpen] = useState(false);
  const [closeupWizardCharKey, setCloseupWizardCharKey] = useState("");

  return (
    <div style={{ minHeight: "100vh" }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center", paddingLeft: 20, marginBottom: 10 }}>
        <HfTokenSettingsButton />
        <SquareIconButton
          onClick={() => router.push("/home")}
          aria-label="Home"
          icon={<HomeIcon />}
        />
        <SquareIconButton
          onClick={() => router.push("/hub")}
          aria-label="Back"
          icon={<TriangleIcon direction="left" />}
        />
      </div>

      <div style={{ paddingLeft: 20, paddingRight: 20, maxWidth: 980 }}>
        <NewCharacterCreatePanel
          variant="page"
          cancelConfirmMessage="Clear all draft images in the workspace and return to the hub?"
          onFinalized={(charKey) => {
            setCloseupWizardCharKey(charKey);
            setCloseupWizardOpen(true);
          }}
          onCancelled={() => router.push("/hub")}
        />
      </div>

      <BaseCloseupWizardModal
        open={closeupWizardOpen}
        charKey={closeupWizardCharKey}
        title="Generate Closeup Angles"
        onClose={async () => {
          const ck = closeupWizardCharKey.trim();
          if (ck) {
            try {
              await apiHubDelete(ck);
            } catch (e) {
              showError({
                message: "Could not remove the character after closing the wizard.",
                error: e,
              });
            }
          }
          setCloseupWizardOpen(false);
          try {
            await apiNewCharacterDraftBases();
          } catch {
            /* ignore */
          }
        }}
        onDone={async () => {
          setCloseupWizardOpen(false);
          try {
            await apiNewCharacterDiscard();
          } catch {
            /* still go to hub */
          }
          router.push("/hub");
        }}
      />
    </div>
  );
}
