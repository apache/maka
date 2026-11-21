---
name: form-wizard-builder
description: Builds multi-step forms with validation schemas (Zod/Yup), step components, shared state management, progress indicators, review steps, and error handling. Use when creating "multi-step forms", "wizard flows", "onboarding forms", or "checkout processes".
---

# Form Wizard Builder

Create multi-step form experiences with validation, state persistence, and review steps.

## Core Workflow

1. **Define steps**: Break form into logical sections
2. **Create schema**: Zod/Yup validation for each step
3. **Build step components**: Individual form sections
4. **State management**: Shared state across steps (Zustand/Context)
5. **Navigation**: Next/Back/Skip logic
6. **Progress indicator**: Visual step tracker
7. **Review step**: Summary before submission
8. **Error handling**: Per-step and final validation

## Basic Wizard Structure

```typescript
// types/wizard.ts
export type WizardStep = {
  id: string;
  title: string;
  description?: string;
  component: React.ComponentType<StepProps>;
  schema: z.ZodSchema;
  isOptional?: boolean;
};

export type WizardData = {
  personal: PersonalInfoData;
  contact: ContactData;
  preferences: PreferencesData;
};
```

## Validation Schemas (Zod)

```typescript
// schemas/wizard.schema.ts
import { z } from "zod";

export const personalInfoSchema = z.object({
  firstName: z.string().min(2, "First name must be at least 2 characters"),
  lastName: z.string().min(2, "Last name must be at least 2 characters"),
  dateOfBirth: z.string().refine((date) => {
    const age = new Date().getFullYear() - new Date(date).getFullYear();
    return age >= 18;
  }, "Must be at least 18 years old"),
});

export const contactSchema = z.object({
  email: z.string().email("Invalid email address"),
  phone: z.string().regex(/^\+?[\d\s-()]+$/, "Invalid phone number"),
  address: z.object({
    street: z.string().min(1, "Street is required"),
    city: z.string().min(1, "City is required"),
    zipCode: z.string().regex(/^\d{5}(-\d{4})?$/, "Invalid ZIP code"),
  }),
});

export const preferencesSchema = z.object({
  notifications: z.object({
    email: z.boolean(),
    sms: z.boolean(),
    push: z.boolean(),
  }),
  interests: z.array(z.string()).min(1, "Select at least one interest"),
});

// Complete wizard schema
export const wizardSchema = z.object({
  personal: personalInfoSchema,
  contact: contactSchema,
  preferences: preferencesSchema,
});

export type WizardFormData = z.infer<typeof wizardSchema>;
```

## State Management (Zustand)

```typescript
// stores/wizard.store.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface WizardState {
  currentStep: number;
  data: Partial<WizardFormData>;
  completedSteps: number[];
  isSubmitting: boolean;

  setCurrentStep: (step: number) => void;
  updateStepData: (step: string, data: any) => void;
  markStepComplete: (step: number) => void;
  nextStep: () => void;
  prevStep: () => void;
  resetWizard: () => void;
  submitWizard: () => Promise<void>;
}

export const useWizardStore = create<WizardState>()(
  persist(
    (set, get) => ({
      currentStep: 0,
      data: {},
      completedSteps: [],
      isSubmitting: false,

      setCurrentStep: (step) => set({ currentStep: step }),

      updateStepData: (step, newData) =>
        set((state) => ({
          data: {
            ...state.data,
            [step]: { ...state.data[step], ...newData },
          },
        })),

      markStepComplete: (step) =>
        set((state) => ({
          completedSteps: Array.from(new Set([...state.completedSteps, step])),
        })),

      nextStep: () =>
        set((state) => ({
          currentStep: Math.min(state.currentStep + 1, steps.length - 1),
        })),

      prevStep: () =>
        set((state) => ({
          currentStep: Math.max(state.currentStep - 1, 0),
        })),

      resetWizard: () =>
        set({
          currentStep: 0,
          data: {},
          completedSteps: [],
          isSubmitting: false,
        }),

      submitWizard: async () => {
        set({ isSubmitting: true });
        try {
          // Submit to API
          await fetch("/api/wizard", {
            method: "POST",
            body: JSON.stringify(get().data),
          });
          get().resetWizard();
        } catch (error) {
          console.error("Submission failed:", error);
        } finally {
          set({ isSubmitting: false });
        }
      },
    }),
    {
      name: "wizard-storage",
    },
  ),
);
```

## Main Wizard Component

```typescript
// components/Wizard.tsx
"use client";

import { useState } from "react";
import { useWizardStore } from "@/stores/wizard.store";
import { ProgressIndicator } from "./ProgressIndicator";
import { PersonalInfoStep } from "./steps/PersonalInfoStep";
import { ContactStep } from "./steps/ContactStep";
import { PreferencesStep } from "./steps/PreferencesStep";
import { ReviewStep } from "./steps/ReviewStep";

const steps = [
  {
    id: "personal",
    title: "Personal Information",
    component: PersonalInfoStep,
    schema: personalInfoSchema,
  },
  {
    id: "contact",
    title: "Contact Details",
    component: ContactStep,
    schema: contactSchema,
  },
  {
    id: "preferences",
    title: "Preferences",
    component: PreferencesStep,
    schema: preferencesSchema,
    isOptional: true,
  },
  {
    id: "review",
    title: "Review",
    component: ReviewStep,
    schema: z.any(),
  },
];

export function Wizard() {
  const { currentStep } = useWizardStore();
  const CurrentStepComponent = steps[currentStep].component;

  return (
    <div className="mx-auto max-w-2xl space-y-8 p-6">
      <ProgressIndicator steps={steps} currentStep={currentStep} />

      <div className="rounded-lg border bg-white p-8 shadow-sm">
        <div className="mb-6">
          <h2 className="text-2xl font-bold">{steps[currentStep].title}</h2>
          {steps[currentStep].description && (
            <p className="text-gray-600">{steps[currentStep].description}</p>
          )}
        </div>

        <CurrentStepComponent />
      </div>
    </div>
  );
}
```

## Progress Indicator

```typescript
// components/ProgressIndicator.tsx
import { cn } from "@/lib/utils";
import { CheckIcon } from "@/components/icons";

interface ProgressIndicatorProps {
  steps: Array<{ id: string; title: string }>;
  currentStep: number;
}

export function ProgressIndicator({
  steps,
  currentStep,
}: ProgressIndicatorProps) {
  return (
    <nav aria-label="Progress">
      <ol className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isComplete = index < currentStep;
          const isCurrent = index === currentStep;

          return (
            <li key={step.id} className="flex flex-1 items-center">
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full border-2",
                    isComplete && "border-primary-500 bg-primary-500",
                    isCurrent && "border-primary-500 bg-white",
                    !isComplete && !isCurrent && "border-gray-300 bg-white"
                  )}
                >
                  {isComplete ? (
                    <CheckIcon className="h-5 w-5 text-white" />
                  ) : (
                    <span
                      className={cn(
                        "text-sm font-medium",
                        isCurrent ? "text-primary-500" : "text-gray-500"
                      )}
                    >
                      {index + 1}
                    </span>
                  )}
                </div>
                <span
                  className={cn(
                    "mt-2 text-sm font-medium",
                    isCurrent ? "text-primary-500" : "text-gray-500"
                  )}
                >
                  {step.title}
                </span>
              </div>

              {index < steps.length - 1 && (
                <div
                  className={cn(
                    "mx-4 h-0.5 flex-1",
                    isComplete ? "bg-primary-500" : "bg-gray-300"
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
```

## Step Component Example

```typescript
// components/steps/PersonalInfoStep.tsx
"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useWizardStore } from "@/stores/wizard.store";
import { personalInfoSchema } from "@/schemas/wizard.schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function PersonalInfoStep() {
  const { data, updateStepData, markStepComplete, nextStep } = useWizardStore();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(personalInfoSchema),
    defaultValues: data.personal || {},
  });

  const onSubmit = (formData: any) => {
    updateStepData("personal", formData);
    markStepComplete(0);
    nextStep();
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="firstName">First Name</Label>
            <Input
              id="firstName"
              {...register("firstName")}
              error={errors.firstName?.message}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="lastName">Last Name</Label>
            <Input
              id="lastName"
              {...register("lastName")}
              error={errors.lastName?.message}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="dateOfBirth">Date of Birth</Label>
          <Input
            id="dateOfBirth"
            type="date"
            {...register("dateOfBirth")}
            error={errors.dateOfBirth?.message}
          />
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="submit">Next Step</Button>
      </div>
    </form>
  );
}
```

## Review Step

```typescript
// components/steps/ReviewStep.tsx
"use client";

import { useWizardStore } from "@/stores/wizard.store";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function ReviewStep() {
  const { data, isSubmitting, submitWizard, setCurrentStep } = useWizardStore();

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Personal Information</h3>
          <Button variant="ghost" size="sm" onClick={() => setCurrentStep(0)}>
            Edit
          </Button>
        </div>
        <dl className="space-y-2">
          <div className="flex justify-between">
            <dt className="text-gray-600">Name:</dt>
            <dd className="font-medium">
              {data.personal?.firstName} {data.personal?.lastName}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-600">Date of Birth:</dt>
            <dd className="font-medium">{data.personal?.dateOfBirth}</dd>
          </div>
        </dl>
      </Card>

      <Card className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Contact Details</h3>
          <Button variant="ghost" size="sm" onClick={() => setCurrentStep(1)}>
            Edit
          </Button>
        </div>
        <dl className="space-y-2">
          <div className="flex justify-between">
            <dt className="text-gray-600">Email:</dt>
            <dd className="font-medium">{data.contact?.email}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-600">Phone:</dt>
            <dd className="font-medium">{data.contact?.phone}</dd>
          </div>
        </dl>
      </Card>

      <div className="flex justify-between">
        <Button
          variant="outline"
          onClick={() => setCurrentStep((prev) => prev - 1)}
        >
          Back
        </Button>
        <Button onClick={submitWizard} isLoading={isSubmitting}>
          Submit Application
        </Button>
      </div>
    </div>
  );
}
```

## Navigation Controls

```typescript
// components/WizardNavigation.tsx
interface WizardNavigationProps {
  onNext?: () => void;
  onPrev?: () => void;
  onSkip?: () => void;
  isFirstStep: boolean;
  isLastStep: boolean;
  isOptional?: boolean;
  nextLabel?: string;
  prevLabel?: string;
}

export function WizardNavigation({
  onNext,
  onPrev,
  onSkip,
  isFirstStep,
  isLastStep,
  isOptional,
  nextLabel = "Next",
  prevLabel = "Back",
}: WizardNavigationProps) {
  return (
    <div className="flex items-center justify-between">
      <div>
        {!isFirstStep && (
          <Button variant="outline" onClick={onPrev}>
            {prevLabel}
          </Button>
        )}
      </div>

      <div className="flex gap-2">
        {isOptional && (
          <Button variant="ghost" onClick={onSkip}>
            Skip
          </Button>
        )}
        <Button onClick={onNext}>{isLastStep ? "Submit" : nextLabel}</Button>
      </div>
    </div>
  );
}
```

## Persistence (LocalStorage)

```typescript
// hooks/useWizardPersistence.ts
import { useEffect } from "react";
import { useWizardStore } from "@/stores/wizard.store";

export function useWizardPersistence() {
  const { data, currentStep } = useWizardStore();

  // Auto-save to localStorage
  useEffect(() => {
    localStorage.setItem("wizard-data", JSON.stringify(data));
    localStorage.setItem("wizard-step", String(currentStep));
  }, [data, currentStep]);

  // Load on mount
  useEffect(() => {
    const savedData = localStorage.getItem("wizard-data");
    const savedStep = localStorage.getItem("wizard-step");

    if (savedData) {
      // Restore state
    }
  }, []);
}
```

## Best Practices

1. **Validate per step**: Don't wait until end
2. **Save progress**: Persist to localStorage/server
3. **Allow navigation**: Let users go back and edit
4. **Show progress**: Clear visual indicator
5. **Review before submit**: Summary step is crucial
6. **Handle errors gracefully**: Show which step has errors
7. **Mobile responsive**: Stack progress on mobile
8. **Accessibility**: Keyboard navigation, ARIA labels

## Output Checklist

- [ ] Step definitions with schemas
- [ ] Validation with Zod/Yup
- [ ] State management (Zustand/Context)
- [ ] Progress indicator component
- [ ] Individual step components
- [ ] Navigation controls (Next/Back/Skip)
- [ ] Review/summary step
- [ ] Error handling per step
- [ ] Persistence mechanism
- [ ] Mobile-responsive design
