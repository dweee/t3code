import type { EnvironmentId, UnifiedSettings, UsageLimitSourceKind } from "@t3tools/contracts";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { sourceIdFromUrl } from "./AddUsageLimitSourceDialog.logic";
import { SecretInput } from "./SecretInput";
import { Label } from "../ui/label";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const KIND_COPY = {
  cliproxy: {
    title: "Add a CLIProxyAPI hub",
    description: "Show the quota of every account the hub pools",
    urlLabel: "Hub URL",
    urlPlaceholder: "https://hub.example.ts.net:8318",
    keyLabel: "Management key",
    labelPlaceholder: "Defaults to the hub's host name",
  },
  codexbar: {
    title: "Add a CodexBar dashboard",
    description: "Show every provider CodexBar tracks, read from `codexbar serve`,",
    urlLabel: "Dashboard URL",
    urlPlaceholder: "http://127.0.0.1:8080",
    keyLabel: "Dashboard token (optional on loopback)",
    labelPlaceholder: "Defaults to the dashboard's host name",
  },
} as const satisfies Record<UsageLimitSourceKind, Record<string, string>>;

/** Send the key or token once to server secret storage; settings retain only a redaction marker. */
export function AddUsageLimitSourceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  sources,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [kind, setKind] = useState<UsageLimitSourceKind>("cliproxy");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const trimmedUrl = url.trim();
  // A loopback `codexbar serve` answers without a token; a hub never does.
  const canSave = trimmedUrl.length > 0 && (kind === "codexbar" || managementKey.trim().length > 0);
  const copy = KIND_COPY[kind];

  const reset = () => {
    setKind("cliproxy");
    setLabel("");
    setUrl("");
    setManagementKey("");
  };

  const save = () => {
    if (!canSave) return;
    const id = sourceIdFromUrl(trimmedUrl, sources, kind);
    updateSettings({
      usageLimitSources: {
        [id]: {
          kind,
          ...(label.trim() ? { label: label.trim() } : {}),
          url: trimmedUrl,
          managementKey: managementKey.trim(),
          enabled: true,
        },
      },
    });
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            {copy.description} next to the providers on {environmentLabel}. The key stays on that
            server.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <ToggleGroup
              aria-label="Source type"
              variant="segmented"
              value={[kind]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "cliproxy" || value === "codexbar") setKind(value);
              }}
            >
              <Toggle value="cliproxy">CLIProxyAPI hub</Toggle>
              <Toggle value="codexbar">CodexBar</Toggle>
            </ToggleGroup>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-url">{copy.urlLabel}</Label>
              <Input
                id="usage-source-url"
                placeholder={copy.urlPlaceholder}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-key">{copy.keyLabel}</Label>
              <SecretInput
                id="usage-source-key"
                value={managementKey}
                onChange={(event) => setManagementKey(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-label">Label (optional)</Label>
              <Input
                id="usage-source-label"
                placeholder={copy.labelPlaceholder}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {kind === "codexbar" ? "Add dashboard" : "Add hub"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
