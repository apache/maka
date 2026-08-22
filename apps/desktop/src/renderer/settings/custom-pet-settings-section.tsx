/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState } from '@astryxdesign/core';
import { Badge, Button, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { SettingsRow, SettingsSection } from './settings-section';
import { settingsActionErrorMessage } from './settings-error-copy';
import { getSettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';
import {
  reconcileCustomPetLibrary,
  removeCustomPet,
  upsertCustomPet,
  type CustomPetLibrarySnapshot,
} from './custom-pet-library-model.js';

const EMPTY_LIBRARY: CustomPetLibrarySnapshot = {
  pets: [],
  selectedPetId: null,
};

type PetMutation =
  | 'import'
  | 'disable'
  | `select:${string}`
  | `remove:${string}`;

export function CustomPetSettingsSection() {
  const locale = useUiLocale();
  const preferencesCopy = getSettingsPreferencesCopy(locale);
  const copy = preferencesCopy.pets;
  const sections = preferencesCopy.sections;
  const toast = useToast();
  const mountedRef = useMountedRef();
  const refreshTicketRef = useRef(0);
  const [library, setLibrary] = useState<CustomPetLibrarySnapshot>(EMPTY_LIBRARY);
  const [loading, setLoading] = useState(true);
  const [mutation, setMutation] = useState<PetMutation | null>(null);

  const refreshLibrary = useCallback(async (options?: {
    showLoading?: boolean;
    reportError?: boolean;
  }) => {
    const ticket = ++refreshTicketRef.current;
    if (options?.showLoading && mountedRef.current) setLoading(true);
    try {
      const [pets, selectedPetId] = await Promise.all([
        window.maka.pets.list(),
        window.maka.pets.getSelection(),
      ]);
      if (mountedRef.current && ticket === refreshTicketRef.current) {
        setLibrary(reconcileCustomPetLibrary(pets, selectedPetId));
      }
    } catch (error) {
      if (
        options?.reportError
        && mountedRef.current
        && ticket === refreshTicketRef.current
      ) {
        toast.error(copy.loadFailed, settingsActionErrorMessage(error, locale));
      }
    } finally {
      if (mountedRef.current && ticket === refreshTicketRef.current) {
        setLoading(false);
      }
    }
  }, [copy.loadFailed, locale, mountedRef, toast]);

  useEffect(() => {
    void refreshLibrary({ showLoading: true, reportError: true });
    const unsubscribe = window.maka.pets.subscribeChanges(() => {
      // The event is only an invalidation signal. Re-read both authorities so
      // install/remove/select events from another window converge identically.
      void refreshLibrary();
    });
    return () => {
      refreshTicketRef.current += 1;
      unsubscribe();
    };
  }, [refreshLibrary]);

  async function importPet() {
    refreshTicketRef.current += 1;
    setMutation('import');
    try {
      const result = await window.maka.pets.importLocalDirectory();
      if (!mountedRef.current) return;
      if (!result.ok) {
        if (result.reason !== 'cancelled') {
          toast.error(copy.importFailed, copy.importErrors[result.reason]);
        }
        return;
      }
      // Import and enable remain separate user choices. Installing a pack must
      // never silently replace the pet the user already selected.
      setLibrary((current) => upsertCustomPet(current, result.manifest));
      await refreshLibrary();
    } catch (error) {
      if (mountedRef.current) {
        toast.error(copy.importFailed, settingsActionErrorMessage(error, locale));
      }
    } finally {
      if (mountedRef.current) setMutation(null);
    }
  }

  async function selectPet(petId: string | null) {
    refreshTicketRef.current += 1;
    setMutation(petId === null ? 'disable' : `select:${petId}`);
    try {
      const result = await window.maka.pets.select(petId);
      if (!mountedRef.current) return;
      if (!result.ok) {
        toast.error(copy.selectFailed, copy.selectErrors[result.reason]);
        return;
      }
      setLibrary((current) => reconcileCustomPetLibrary(
        current.pets,
        result.selectedPetId,
      ));
      await refreshLibrary();
    } catch (error) {
      if (mountedRef.current) {
        toast.error(copy.selectFailed, settingsActionErrorMessage(error, locale));
      }
    } finally {
      if (mountedRef.current) setMutation(null);
    }
  }

  async function requestRemovePet(petId: string) {
    const pet = library.pets.find((candidate) => candidate.id === petId);
    if (!pet) return;
    const confirmed = await toast.confirm({
      title: copy.removeTitle(pet.displayName),
      description: copy.removeDescription,
      confirmLabel: copy.confirmRemove,
      cancelLabel: copy.cancel,
      destructive: true,
    });
    if (!confirmed || !mountedRef.current) return;

    refreshTicketRef.current += 1;
    setMutation(`remove:${petId}`);
    try {
      const result = await window.maka.pets.remove(petId);
      if (!mountedRef.current) return;
      if (!result.ok) {
        toast.error(copy.removeFailed, copy.removeErrors[result.reason]);
        return;
      }
      setLibrary((current) => removeCustomPet(current, petId));
      await refreshLibrary();
    } catch (error) {
      if (mountedRef.current) {
        toast.error(copy.removeFailed, settingsActionErrorMessage(error, locale));
      }
    } finally {
      if (mountedRef.current) setMutation(null);
    }
  }

  const selectedPet = library.pets.find((pet) => pet.id === library.selectedPetId);
  const actionDisabled = loading || mutation !== null;

  return (
    <SettingsSection
      title={sections.pets}
      description={sections.petsHelp}
      action={(
        <Button
          variant="secondary"
          size="sm"
          isDisabled={actionDisabled}
          onClick={() => void importPet()}
          label={mutation === 'import' ? copy.importing : copy.import}
        />
      )}
    >
      <SettingsRow
        label={copy.status}
        description={loading
          ? copy.loading
          : selectedPet
            ? copy.activePet(selectedPet.displayName)
            : copy.disabled}
        end={loading ? undefined : selectedPet ? (
          <Button
            variant="secondary"
            size="sm"
            isDisabled={actionDisabled}
            onClick={() => void selectPet(null)}
            label={mutation === 'disable' ? copy.disabling : copy.disable}
          />
        ) : (
          <Badge variant="neutral" label={copy.disabled} />
        )}
      />

      {loading && library.pets.length === 0 ? (
        <EmptyState isCompact title={copy.loading} />
      ) : null}

      {!loading && library.pets.length === 0 ? (
        <EmptyState isCompact title={copy.empty} description={copy.emptyHelp} />
      ) : null}

      {library.pets.map((pet) => {
        const isSelected = pet.id === library.selectedPetId;
        const isSelecting = mutation === `select:${pet.id}`;
        const isRemoving = mutation === `remove:${pet.id}`;
        return (
          <SettingsRow
            key={pet.id}
            label={pet.displayName}
            description={pet.description ? `${pet.description} · ${pet.id}` : pet.id}
            end={(
              <>
                {isSelected ? (
                  <Badge variant="neutral" label={copy.selected} />
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    isDisabled={actionDisabled}
                    onClick={() => void selectPet(pet.id)}
                    label={isSelecting ? copy.selecting : copy.select}
                  />
                )}
                <Button
                  variant="destructive"
                  size="sm"
                  isDisabled={actionDisabled}
                  onClick={() => void requestRemovePet(pet.id)}
                  label={isRemoving ? copy.removing : copy.remove}
                />
              </>
            )}
          />
        );
      })}
    </SettingsSection>
  );
}
