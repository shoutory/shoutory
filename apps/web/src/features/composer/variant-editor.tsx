import { Trans, useLingui } from "@lingui/react/macro";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { Button } from "../../ui/button";
import { DirText } from "../../ui/dir-text";
import { Select } from "../../ui/select";
import { TextArea } from "../../ui/text-area";
import {
  countersOf,
  type Doc,
  type Issue,
  type PostType,
  type Provider,
  postTypesOf,
  textOf,
  type VariantDoc,
  withVariant,
} from "./composer-data";
import { CounterLine, useIssueWords } from "./counters";

export interface Channels {
  nameOf: (channelId: string) => string;
  providerOf: (channelId: string) => Provider | undefined;
}

export interface EditorProps {
  doc: Doc;
  onDoc: (doc: Doc) => void;
  channels: Channels;
  tab: string;
  onTab: (tab: string) => void;
  /** Answers of the server to a schedule or publish attempt, shown under the field they name. */
  refused: readonly Issue[];
  readOnly: boolean;
  onBlur: () => void;
}

function usePostTypeWords(): Record<string, string> {
  const { t } = useLingui();
  return {
    text: t({ id: "composer.type.text", message: "Text" }),
    image: t({ id: "composer.type.image", message: "One image" }),
    multi_image: t({ id: "composer.type.multi_image", message: "Several images" }),
    video: t({ id: "composer.type.video", message: "Video" }),
  };
}

const inlineText = (
  issues: readonly Issue[],
  key: string,
  words: ReturnType<typeof useIssueWords>,
  name: (id: string) => string,
) =>
  issues
    .filter((issue) => issue.key === key)
    .map((issue) => words(issue, name(issue.channelId)))
    .join(" ");

function BaseTab({ doc, onDoc, channels, refused, readOnly, onBlur }: EditorProps) {
  const { t } = useLingui();
  const words = useIssueWords();
  const shared = doc.variants.filter((variant) => variant.override === null);
  const error = inlineText(
    refused.filter((issue) => shared.some((variant) => variant.channelId === issue.channelId)),
    "text",
    words,
    channels.nameOf,
  );
  return (
    <div className="flex flex-col gap-3">
      <TextArea
        label={t({ id: "composer.base.label", message: "Post text" })}
        testId="composer-base"
        field="text:all"
        value={doc.base}
        onChange={(base) => onDoc({ ...doc, base })}
        onBlur={onBlur}
        isReadOnly={readOnly}
        rows={6}
        {...(error === "" ? {} : { errorMessage: error })}
      />
      <div className="flex flex-col gap-1 text-sm text-text-muted">
        {doc.variants.map((variant) => {
          const provider = channels.providerOf(variant.channelId);
          return (
            <div key={variant.channelId} className="flex flex-wrap gap-x-3">
              <DirText>{channels.nameOf(variant.channelId)}</DirText>
              {provider ? (
                <CounterLine
                  testId={`counter-${variant.channelId}`}
                  counters={countersOf(provider, textOf(doc, variant))}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChannelTab({ variant, props }: { variant: VariantDoc; props: EditorProps }) {
  const { t } = useLingui();
  const typeWords = usePostTypeWords();
  const words = useIssueWords();
  const { doc, onDoc, channels, readOnly, onBlur, refused } = props;
  const provider = channels.providerOf(variant.channelId);
  const overridden = variant.override !== null;
  const types = provider ? postTypesOf(provider) : [];
  const error = inlineText(
    refused.filter((issue) => issue.channelId === variant.channelId),
    "text",
    words,
    channels.nameOf,
  );
  return (
    <div className="flex flex-col gap-3">
      <p data-testid="variant-badge" data-overridden={overridden}>
        {overridden ? (
          <Trans id="composer.variant.overridden">Overridden</Trans>
        ) : (
          <Trans id="composer.variant.same">Same as base</Trans>
        )}
      </p>
      <TextArea
        label={t({ id: "composer.variant.label", message: "Text for this channel" })}
        testId="composer-variant-text"
        field={`text:${variant.channelId}`}
        value={textOf(doc, variant)}
        onChange={(override) => onDoc(withVariant(doc, variant.channelId, { override }))}
        onBlur={onBlur}
        isReadOnly={readOnly}
        {...(error === "" ? {} : { errorMessage: error })}
      />
      {provider ? (
        <CounterLine testId="variant-counter" counters={countersOf(provider, textOf(doc, variant))} />
      ) : null}
      {overridden && !readOnly ? (
        <div>
          <Button
            data-testid="variant-reset"
            onPress={() => onDoc(withVariant(doc, variant.channelId, { override: null }))}
          >
            <Trans id="composer.variant.reset">Reset to base</Trans>
          </Button>
        </div>
      ) : null}
      <Select
        label={t({ id: "composer.variant.post_type", message: "Post type" })}
        testId="variant-post-type"
        value={variant.postType}
        options={types.map((type) => ({ value: type, label: typeWords[type] ?? type }))}
        onChange={(postType) =>
          onDoc(withVariant(doc, variant.channelId, { postType: postType as PostType }))
        }
        unavailable={readOnly}
      />
    </div>
  );
}

export function VariantEditor(props: EditorProps) {
  const { t } = useLingui();
  const { doc, channels, tab, onTab } = props;
  return (
    <Tabs selectedKey={tab} onSelectionChange={(key) => onTab(String(key))} className="flex flex-col gap-4">
      <TabList
        aria-label={t({ id: "composer.tabs.label", message: "Text and files by channel" })}
        className="flex flex-wrap gap-2"
      >
        <Tab
          id="all"
          data-testid="tab-all"
          className="min-h-10 pointer-coarse:min-h-11 cursor-default rounded-md border border-border px-4 py-2 outline-offset-2 data-[selected]:bg-highlight data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
        >
          <Trans id="composer.tabs.all">All channels</Trans>
        </Tab>
        {doc.variants.map((variant) => (
          <Tab
            key={variant.channelId}
            id={variant.channelId}
            data-testid="tab-channel"
            className="min-h-10 pointer-coarse:min-h-11 cursor-default rounded-md border border-border px-4 py-2 outline-offset-2 data-[selected]:bg-highlight data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
          >
            <DirText>{channels.nameOf(variant.channelId)}</DirText>
          </Tab>
        ))}
      </TabList>
      <TabPanel id="all">
        <BaseTab {...props} />
      </TabPanel>
      {doc.variants.map((variant) => (
        <TabPanel key={variant.channelId} id={variant.channelId}>
          <ChannelTab variant={variant} props={props} />
        </TabPanel>
      ))}
    </Tabs>
  );
}
