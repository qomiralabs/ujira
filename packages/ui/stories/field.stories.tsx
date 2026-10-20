// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { useForm } from 'react-hook-form';
import { Button } from '../src/primitives/button.js';
import { Field, type FieldProps } from '../src/primitives/field.js';
import { Input } from '../src/primitives/input.js';
import { focusFirst } from './helpers.js';

interface ReferenceFieldProps extends Omit<FieldProps, 'children'> {
  disabled?: boolean;
}

function ReferenceField({ disabled, ...props }: ReferenceFieldProps) {
  return (
    <div className="max-w-sm">
      <Field {...props}>
        <Input defaultValue="Batch 14" disabled={disabled} />
      </Field>
    </div>
  );
}

const meta = {
  title: 'Primitives/Field',
  component: ReferenceField,
  args: {
    label: 'Reference',
    hint: 'Shown on the receipt, so the recipient knows what the payout is for.',
  },
} satisfies Meta<typeof ReferenceField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Required: Story = { args: { required: true, hint: undefined } };

export const Focus: Story = { play: focusFirst };

export const Disabled: Story = { args: { disabled: true } };

export const Invalid: Story = {
  args: { error: 'Keep the reference under 40 characters.' },
};

interface MandateForm {
  name: string;
  email: string;
}

function MandateFormExample() {
  const { register, handleSubmit, formState } = useForm<MandateForm>({
    defaultValues: { name: '', email: '' },
  });
  const { errors, isSubmitSuccessful } = formState;
  return (
    <form
      noValidate
      className="flex max-w-sm flex-col gap-5"
      onSubmit={(event) => void handleSubmit(() => undefined)(event)}
    >
      <Field label="Mandate name" required error={errors.name?.message}>
        <Input {...register('name', { required: 'Give the mandate a name.' })} />
      </Field>
      <Field
        label="Approver email"
        hint="This person approves payouts over the cap."
        error={errors.email?.message}
      >
        <Input
          type="email"
          {...register('email', {
            pattern: {
              value: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
              message: 'Enter a full email address.',
            },
          })}
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary">
          Create mandate
        </Button>
        {isSubmitSuccessful ? <p className="text-body-s text-text-secondary">Saved.</p> : null}
      </div>
    </form>
  );
}

/** react-hook-form wiring: submit with the name empty to see the error linked to its input. */
export const WithReactHookForm: Story = {
  render: () => <MandateFormExample />,
};
