import { handleReload } from "../../feats/crossbow-feats.js";
import { getControlledActorAndToken, getEffectFromActor, getFlag, getItem, postInChat, setEffectTarget, showWarning, Updates, useAdvancedAmmunitionSystem } from "../../utils/utils.js";
import { getWeapon, getWeapons } from "../../utils/weapon-utils.js";
import { CONJURED_ROUND_EFFECT_ID, LOADED_EFFECT_ID, MAGAZINE_LOADED_EFFECT_ID, RELOAD_AMMUNITION_IMG } from "../constants.js";
import { buildLoadedEffectName, checkFullyLoaded, isFullyLoaded } from "../utils.js";
import { setLoadedChamber } from "./next-chamber.js";
import { selectAmmunition } from "./switch-ammunition.js";
import { unloadAmmunition } from "./unload.js";

export async function reload() {
    const { actor, token } = getControlledActorAndToken();
    if (!actor) {
        return;
    }

    const weapon = await getWeapon(
        actor,
        weapon => weapon.requiresLoading,
        "You have no reloadable weapons.",
        weapon => !isFullyLoaded(actor, weapon)
    );
    if (!weapon) {
        return;
    }

    const updates = new Updates(actor);

    await performReload(actor, token, weapon, updates);

    updates.handleUpdates();
}

export async function reloadNPCs() {
    try {
        CONFIG.pf2eRangedCombat.silent = true;
                
        const nonPlayerTokens = Array.from(canvas.scene.tokens).filter(token => !token.actor.hasPlayerOwner);
        for (const token of nonPlayerTokens) {
            const actor = token.actor;
            const weapons = await getWeapons(
                actor,
                weapon => weapon.requiresLoading,
                "You have no reloadable weapons."
            );

            const updates = new Updates(actor);

            for (const weapon of weapons) {
                await performReload(actor, token, weapon, updates);
            }

            updates.handleUpdates();
        }
    } finally {
        CONFIG.pf2eRangedCombat.silent = false;
    }
}

async function performReload(actor, token, weapon, updates) {
    if (useAdvancedAmmunitionSystem(actor)) {
        if (weapon.isRepeating) {
            // With a repeating weapon, we only need to have a magazine loaded with at least one ammunition remaining. The ammunition itself
            // is still only consumed when we fire
            const magazineLoadedEffect = getEffectFromActor(actor, MAGAZINE_LOADED_EFFECT_ID, weapon.id);
            if (!magazineLoadedEffect) {
                showWarning(`${weapon.name} has no magazine loaded!`);
                return;
            } else if (getFlag(magazineLoadedEffect, "remaining") < 1) {
                showWarning(`${weapon.name}'s magazine is empty!`);
                return;
            }

            // If the weapon is already loaded, we don't need to do it again
            const loadedEffect = getEffectFromActor(actor, LOADED_EFFECT_ID, weapon.id);
            if (loadedEffect) {
                showWarning(`${weapon.name} is already loaded.`);
                return;
            }

            // Create the new loaded effect
            const loadedEffectSource = await getItem(LOADED_EFFECT_ID);
            setEffectTarget(loadedEffectSource, weapon);
            updates.create(loadedEffectSource);

            await postReloadToChat(token, weapon);
        } else {
            // If we have no ammunition selected, or we don't have any left in the stack, we can't reload
            const ammo = await getAmmunition(weapon, updates);
            if (!ammo) {
                return;
            }

            if (weapon.capacity) {
                if (isFullyLoaded(actor, weapon)) {
                    showWarning(`${weapon.name} is already fully loaded.`);
                    return;
                }

                // If some chambers are already loaded, we only want to load with the same type of ammunition
                const loadedEffect = getEffectFromActor(actor, LOADED_EFFECT_ID, weapon.id);
                if (loadedEffect) {
                    const loadedChambers = getFlag(loadedEffect, "loadedChambers");
                    const loadedCapacity = getFlag(loadedEffect, "capacity");
                    const loadedAmmunitions = getFlag(loadedEffect, "ammunition");

                    let loadedAmmunition = loadedAmmunitions.find(ammunition => ammunition.sourceId === ammo.sourceId);
                    if (loadedAmmunition) {
                        loadedAmmunition.quantity++;
                    } else {
                        loadedAmmunition = {
                            name: ammo.name,
                            img: ammo.img,
                            id: ammo.id,
                            sourceId: ammo.sourceId,
                            quantity: 1
                        };
                        loadedAmmunitions.push(loadedAmmunition);
                    }

                    // Increase the number of loaded chambers by one
                    updates.update(
                        loadedEffect,
                        {
                            name: buildLoadedEffectName(loadedEffect),
                            flags: {
                                "pf2e-ranged-combat": {
                                    loadedChambers: loadedChambers + 1,
                                    ammunition: loadedAmmunitions
                                }
                            }
                        }
                    );
                    updates.floatyText(`${getFlag(loadedEffect, "originalName")} ${loadedAmmunition.name} ${loadedChambers + 1}/${loadedCapacity}`, true);
                } else {
                    // No chambers are loaded, so create a new loaded effect
                    const loadedEffectSource = await getItem(LOADED_EFFECT_ID);
                    updates.create(loadedEffectSource);

                    setEffectTarget(loadedEffectSource, weapon);

                    loadedEffectSource.flags["pf2e-ranged-combat"] = {
                        ...loadedEffectSource.flags["pf2e-ranged-combat"],
                        originalName: loadedEffectSource.name,
                        ammunition: [
                            {
                                name: ammo.name,
                                img: ammo.img,
                                id: ammo.id,
                                sourceId: ammo.sourceId,
                                quantity: 1
                            }
                        ],
                        loadedChambers: 1,
                        capacity: weapon.capacity
                    };
                    loadedEffectSource.name = `${loadedEffectSource.name} (${ammo.name}) (1/${weapon.capacity})`;
                }

                // For a capacity weapon, if the selected chamber isn't loaded, assume the chamber being loaded is the selected one
                if (weapon.isCapacity) {
                    await setLoadedChamber(actor, weapon, ammo, updates);
                }

                await postReloadToChat(token, weapon, ammo.name);
            } else {
                // If the weapon is already loaded with the same type of ammunition as we're loading, don't reload
                // Otherwise, unload the existing round before loading the new one
                const loadedEffect = getEffectFromActor(actor, LOADED_EFFECT_ID, weapon.id);
                const conjuredRoundEffect = getEffectFromActor(actor, CONJURED_ROUND_EFFECT_ID, weapon.id);
                if (conjuredRoundEffect) {
                    updates.delete(conjuredRoundEffect);
                } else if (loadedEffect) {
                    // If the selected ammunition is the same as what's already loaded, don't reload
                    const loadedAmmunition = getFlag(loadedEffect, "ammunition");
                    if (ammo.sourceId === loadedAmmunition.sourceId) {
                        showWarning(`${weapon.name} is already loaded with ${ammo.name}.`);
                        return;
                    }
                    await unloadAmmunition(actor, weapon, updates);
                }

                // Now we can load the new ammunition
                const loadedEffectSource = await getItem(LOADED_EFFECT_ID);
                updates.create(loadedEffectSource);

                setEffectTarget(loadedEffectSource, weapon);
                loadedEffectSource.name = `${loadedEffectSource.name} (${ammo.name})`;
                loadedEffectSource.flags["pf2e-ranged-combat"] = {
                    ...loadedEffectSource.flags["pf2e-ranged-combat"],
                    ammunition: {
                        name: ammo.name,
                        img: ammo.img,
                        id: ammo.id,
                        sourceId: ammo.sourceId
                    }
                };

                await postReloadToChat(token, weapon, ammo.name);
            }

            // Remove one piece of ammunition from the stack
            updates.update(ammo, { "system.quantity": ammo.quantity - 1 });
        }
    } else {
        if (checkFullyLoaded(actor, weapon)) {
            return;
        }

        // If the weapon is already loaded, we don't need to do it again
        const loadedEffect = getEffectFromActor(actor, LOADED_EFFECT_ID, weapon.id);

        if (weapon.capacity) {
            if (loadedEffect) {
                const loadedChambers = getFlag(loadedEffect, "loadedChambers");
                const loadedCapacity = getFlag(loadedEffect, "capacity");

                updates.update(
                    loadedEffect,
                    {
                        "name": `${getFlag(loadedEffect, "name")} (${loadedChambers + 1}/${loadedCapacity})`,
                        "flags.pf2e-ranged-combat.loadedChambers": loadedChambers + 1
                    }
                );
                updates.floatyText(`${getFlag(loadedEffect, "name")} (${loadedChambers + 1}/${loadedCapacity})`, true);

                if (weapon.isCapacity) {
                    await setLoadedChamber(actor, weapon, null, updates);
                }
            } else {
                const loadedEffectSource = await getItem(LOADED_EFFECT_ID);
                setEffectTarget(loadedEffectSource, weapon);
                updates.create(loadedEffectSource);

                const loadedEffectName = loadedEffectSource.name;
                loadedEffectSource.name = `${loadedEffectName} (1/${weapon.capacity})`;
                loadedEffectSource.flags["pf2e-ranged-combat"] = {
                    ...loadedEffectSource.flags["pf2e-ranged-combat"],
                    name: loadedEffectName,
                    loadedChambers: 1,
                    capacity: weapon.capacity
                };

                if (weapon.isCapacity) {
                    await setLoadedChamber(actor, weapon, null, updates);
                }
            }
        } else {
            // Create the new loaded effect
            const loadedEffectSource = await getItem(LOADED_EFFECT_ID);
            setEffectTarget(loadedEffectSource, weapon);
            updates.create(loadedEffectSource);
        }
        await postReloadToChat(token, weapon);
    }

    await handleReload(weapon, updates);
    Hooks.callAll("pf2eRangedCombatReload", actor, token, weapon);
};

async function getAmmunition(weapon, updates) {
    const ammunition = weapon.ammunition;

    if (!ammunition) {
        return await selectAmmunition(
            weapon,
            updates,
            `You have no equipped ammunition compatible with ${weapon.name}.`,
            `You have no ammunition selected for your ${weapon.name}.</p><p>Select the ammunition to load.`,
            false,
            false
        );
    } else if (ammunition.quantity < 1) {
        return await selectAmmunition(
            weapon,
            updates,
            `Not enough ammunition to reload ${weapon.name}.`,
            `Your selected ammunition for your ${weapon.name} is empty.</p><p>Select new ammunition to load.`,
            true,
            false
        );
    } else {
        return ammunition;
    }
}

async function postReloadToChat(token, weapon, ammunitionName) {
    const reloadActions = weapon.reload;
    let desc = `${token.name} reloads their ${weapon.name}`;
    if (ammunitionName) {
        desc = `${desc} with ${ammunitionName}.`;
    } else {
        desc = `${desc}.`;
    }

    await postInChat(
        token.actor,
        RELOAD_AMMUNITION_IMG,
        desc,
        "Interact",
        reloadActions <= 3 ? String(reloadActions) : "",
    );
}
