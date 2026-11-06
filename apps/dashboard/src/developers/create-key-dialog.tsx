// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Field,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ujira/ui';
import { CircleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import {
  API_KEY_DEFAULT_EXPIRY_DAYS,
  API_KEY_MAX_ACTIVE,
  API_KEY_NAME_MAX,
  API_KEY_PRESET_IDS,
  API_SCOPES,
  ApiKeyName,
  type ApiKeyIssued,
  type ApiKeyPreset,
  type ApiKeysApi,
  type ApiScope,
  type CreateApiKeyRequest,
} from '../data/api-keys';
import { ApiProblem, referenceOf } from '../data/client';
import { formatDate } from '../patterns/dates';
import { PRESET_LABELS, scopeLabel } from './key-status';
import { StepUpCancelled, useStepUp } from './step-up';

const DAY_MS = 86_400_000;

const EXPIRY_CHOICES = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '180 days' },
  { days: 365, label: '1 year' },
  { days: 730, label: '2 years' },
] as const;

type Access = ApiKeyPreset | 'custom';

interface FormValues {
  name: string;
  access: Access | '';
  scopes: ApiScope[];
  expiresInDays: string;
}

interface FormError {
  text: string;
  reference?: string | undefined;
}

interface CreateKeyDialogProps {
  api: ApiKeysApi;
  project: string;
  now: Date;
  onCancel: () => void;
  onCreated: (issued: ApiKeyIssued) => void;
}

function requestOf(values: FormValues): CreateApiKeyRequest {
  const name = values.name.trim();
  const expiresInDays = Number.parseInt(values.expiresInDays, 10);
  if (values.access === 'custom' || values.access === '') {
    // In the order the API lists them, whatever order they were ticked in.
    const scopes = API_SCOPES.filter((scope) => values.scopes.includes(scope));
    return { name, scopes, expiresInDays };
  }
  return { name, preset: values.access, expiresInDays };
}

export function CreateKeyDialog({ api, project, now, onCancel, onCreated }: CreateKeyDialogProps) {
  const { withStepUp } = useStepUp();
  const [formError, setFormError] = useState<FormError | null>(null);
  const scopesId = useId();
  const {
    register,
    control,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: {
      name: '',
      access: '',
      scopes: [],
      expiresInDays: String(API_KEY_DEFAULT_EXPIRY_DAYS),
    },
  });

  const access = watch('access');
  const expiryDays = Number.parseInt(watch('expiresInDays'), 10);
  const stopsOn = new Date(now.getTime() + expiryDays * DAY_MS);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      onCreated(await withStepUp(() => api.create(project, requestOf(values))));
    } catch (error) {
      if (error instanceof StepUpCancelled) {
        setFormError({
          text: 'No key was created. Changing API keys needs the code from your authenticator app.',
        });
      } else if (error instanceof ApiProblem && error.code === 'API_KEY_LIMIT_REACHED') {
        setFormError({
          text: `This project already has ${String(API_KEY_MAX_ACTIVE)} live keys, the most it can hold. Revoke one you no longer use, then create this one.`,
        });
      } else if (error instanceof ApiProblem && error.code === 'API_KEY_EXPIRY_INVALID') {
        setError('expiresInDays', {
          message: 'Choose when the key stops working, from 1 day to 2 years.',
        });
      } else if (error instanceof ApiProblem && error.hasFieldError('name')) {
        setError('name', {
          message: `Use a name of up to ${String(API_KEY_NAME_MAX)} characters, on one line.`,
        });
      } else if (error instanceof ApiProblem && error.code === 'INSUFFICIENT_SCOPE') {
        setFormError({ text: 'Only an owner or an admin of this project can create keys.' });
      } else {
        setFormError({
          text: 'The key was not created, and nothing changed. Try again in a moment.',
          reference: referenceOf(error),
        });
      }
    }
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent pending={isSubmitting} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogTitle>Create an API key</DialogTitle>
        <DialogDescription>
          Your software sends this key with each request to UJIRA. It can only do what you allow
          here, and it stops working on the day it expires.
        </DialogDescription>
        <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-6">
          <Field
            label="Name"
            hint="So you can tell your keys apart, for example Payroll server."
            error={errors.name?.message}
            required
          >
            <Input
              autoComplete="off"
              maxLength={API_KEY_NAME_MAX}
              disabled={isSubmitting}
              {...register('name', {
                validate: (value) =>
                  value.trim() === ''
                    ? 'Give the key a name.'
                    : ApiKeyName.safeParse(value).success ||
                      `Use a name of up to ${String(API_KEY_NAME_MAX)} characters, on one line.`,
              })}
            />
          </Field>

          <Controller
            control={control}
            name="access"
            rules={{ validate: (value) => value !== '' || 'Choose what this key may do.' }}
            render={({ field }) => (
              <Field label="Permissions" error={errors.access?.message} required>
                <RadioGroup
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={isSubmitting}
                >
                  {API_KEY_PRESET_IDS.map((preset) => (
                    <RadioGroupItem
                      key={preset}
                      value={preset}
                      label={PRESET_LABELS[preset].label}
                      description={PRESET_LABELS[preset].description}
                    />
                  ))}
                  <RadioGroupItem
                    value="custom"
                    label="Choose permissions"
                    description="Tick exactly what this key may do, and nothing more."
                  />
                </RadioGroup>
              </Field>
            )}
          />

          {access === 'custom' ? (
            <Controller
              control={control}
              name="scopes"
              rules={{
                validate: (value, all) =>
                  all.access !== 'custom' || value.length > 0 || 'Tick at least one permission.',
              }}
              render={({ field }) => (
                <fieldset
                  className="flex flex-col gap-3"
                  aria-describedby={errors.scopes ? `${scopesId}-error` : undefined}
                >
                  <legend className="mb-3 text-body-s font-medium text-text">
                    What this key may do
                  </legend>
                  {API_SCOPES.map((scope) => {
                    const id = `${scopesId}-${scope}`;
                    return (
                      <div key={scope} className="flex items-start gap-3">
                        <Checkbox
                          id={id}
                          disabled={isSubmitting}
                          checked={field.value.includes(scope)}
                          aria-invalid={errors.scopes ? true : undefined}
                          onCheckedChange={(checked) => {
                            field.onChange(
                              checked === true
                                ? [...field.value, scope]
                                : field.value.filter((s) => s !== scope),
                            );
                          }}
                        />
                        <label htmlFor={id} className="flex flex-col gap-0.5 text-body-s text-text">
                          <span>{scopeLabel(scope)}</span>
                          <span className="font-mono text-data text-text-secondary">{scope}</span>
                        </label>
                      </div>
                    );
                  })}
                  {errors.scopes?.message === undefined ? null : (
                    <p
                      id={`${scopesId}-error`}
                      className="flex items-start gap-2 text-body-s text-blocked"
                    >
                      <CircleAlert
                        aria-hidden="true"
                        strokeWidth={1.5}
                        className="mt-0.5 size-4 shrink-0"
                      />
                      <span>{errors.scopes.message}</span>
                    </p>
                  )}
                </fieldset>
              )}
            />
          ) : null}

          <Controller
            control={control}
            name="expiresInDays"
            render={({ field }) => (
              <Field
                label="Expires after"
                hint={`It stops working on ${formatDate(stopsOn)}. Rotate it before then to keep going.`}
                error={errors.expiresInDays?.message}
              >
                <Select value={field.value} onValueChange={field.onChange} disabled={isSubmitting}>
                  <SelectTrigger className="max-w-60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_CHOICES.map((choice) => (
                      <SelectItem key={choice.days} value={String(choice.days)}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          />

          {formError === null ? null : (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-control border border-rule bg-bg p-3 text-body-s text-text"
            >
              <CircleAlert
                aria-hidden="true"
                strokeWidth={1.5}
                className="mt-0.5 size-4 shrink-0"
              />
              <p>
                {formError.text}
                {formError.reference === undefined ? null : (
                  <>
                    {' '}
                    Reference{' '}
                    <span className="font-mono text-data select-all">{formError.reference}</span>
                  </>
                )}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="secondary" disabled={isSubmitting} onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={isSubmitting}>
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
