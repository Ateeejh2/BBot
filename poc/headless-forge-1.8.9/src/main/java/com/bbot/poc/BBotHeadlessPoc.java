package com.bbot.poc;

import net.minecraft.client.Minecraft;
import net.minecraft.client.settings.KeyBinding;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.common.event.FMLInitializationEvent;
import net.minecraftforge.fml.common.eventhandler.SubscribeEvent;
import net.minecraftforge.fml.common.gameevent.TickEvent;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

@Mod(
    modid = BBotHeadlessPoc.MODID,
    name = BBotHeadlessPoc.NAME,
    version = BBotHeadlessPoc.VERSION,
    acceptedMinecraftVersions = "[1.8.9]",
    acceptableRemoteVersions = "*",
    clientSideOnly = true
)
public final class BBotHeadlessPoc {
    public static final String MODID = "bbotheadlesspoc";
    public static final String NAME = "BBot Headless PoC";
    public static final String VERSION = "0.1.0";

    private static final Logger LOG = LogManager.getLogger(NAME);
    private static final int DEFAULT_WARMUP_TICKS = 300;
    private static final int DEFAULT_WALK_TICKS = 200;
    private static final int DEFAULT_SPRINT_TICKS = 200;
    private static final int DEFAULT_TRACE_EVERY_TICKS = 20;

    private enum Phase {
        WAITING_FOR_WORLD,
        WARMUP,
        WALK,
        SPRINT,
        DONE
    }

    private final Minecraft mc = Minecraft.getMinecraft();
    private Phase phase = Phase.WAITING_FOR_WORLD;
    private int phaseTicks;
    private int totalTicks;
    private boolean hadWorld;

    private boolean havePreviousPosition;
    private double previousX;
    private double previousY;
    private double previousZ;

    private final int warmupTicks = envInt("BBOT_POC_WARMUP_TICKS", DEFAULT_WARMUP_TICKS);
    private final int walkTicks = envInt("BBOT_POC_WALK_TICKS", DEFAULT_WALK_TICKS);
    private final int sprintTicks = envInt("BBOT_POC_SPRINT_TICKS", DEFAULT_SPRINT_TICKS);
    private final int traceEveryTicks = Math.max(1, envInt("BBOT_POC_TRACE_EVERY_TICKS", DEFAULT_TRACE_EVERY_TICKS));

    @Mod.EventHandler
    public void init(FMLInitializationEvent event) {
        MinecraftForge.EVENT_BUS.register(this);
        LOG.info(
            "[BBotPoC] ready warmup={} walk={} sprint={} traceEvery={}",
            warmupTicks,
            walkTicks,
            sprintTicks,
            traceEveryTicks
        );
    }

    @SubscribeEvent
    public void onClientTick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END) {
            return;
        }

        if (mc.thePlayer == null || mc.theWorld == null) {
            if (hadWorld) {
                LOG.info("[BBotPoC] world left; resetting test");
            }

            releaseMovementKeys();
            resetTest();
            hadWorld = false;
            return;
        }

        hadWorld = true;
        totalTicks++;

        tracePositionJump();

        switch (phase) {
            case WAITING_FOR_WORLD:
                transitionTo(Phase.WARMUP);
                break;
            case WARMUP:
                setMovement(false, false);
                if (++phaseTicks >= warmupTicks) {
                    transitionTo(Phase.WALK);
                }
                break;
            case WALK:
                setMovement(true, false);
                if (++phaseTicks >= walkTicks) {
                    transitionTo(Phase.SPRINT);
                }
                break;
            case SPRINT:
                setMovement(true, true);
                if (++phaseTicks >= sprintTicks) {
                    transitionTo(Phase.DONE);
                }
                break;
            case DONE:
                setMovement(false, false);
                break;
            default:
                break;
        }

        if (totalTicks % traceEveryTicks == 0) {
            logState("tick");
        }
    }

    private void transitionTo(Phase next) {
        phase = next;
        phaseTicks = 0;

        if (next == Phase.DONE) {
            releaseMovementKeys();
        }

        LOG.info("[BBotPoC] phase={}", next);
        logState("phase");
    }

    private void setMovement(boolean forward, boolean sprint) {
        KeyBinding.setKeyBindState(mc.gameSettings.keyBindForward.getKeyCode(), forward);
        KeyBinding.setKeyBindState(mc.gameSettings.keyBindSprint.getKeyCode(), sprint);
    }

    private void releaseMovementKeys() {
        if (mc.gameSettings == null) {
            return;
        }

        setMovement(false, false);
    }

    private void resetTest() {
        phase = Phase.WAITING_FOR_WORLD;
        phaseTicks = 0;
        totalTicks = 0;
        havePreviousPosition = false;
    }

    private void tracePositionJump() {
        double x = mc.thePlayer.posX;
        double y = mc.thePlayer.posY;
        double z = mc.thePlayer.posZ;

        if (havePreviousPosition) {
            double dx = x - previousX;
            double dy = y - previousY;
            double dz = z - previousZ;
            double horizontal = Math.sqrt(dx * dx + dz * dz);

            if (horizontal > 0.75D || Math.abs(dy) > 1.0D) {
                LOG.warn(
                    "[BBotPoC] position-jump phase={} dh={} dy={} from={},{},{} to={},{},{}",
                    phase,
                    round3(horizontal),
                    round3(dy),
                    round3(previousX),
                    round3(previousY),
                    round3(previousZ),
                    round3(x),
                    round3(y),
                    round3(z)
                );
            }
        }

        previousX = x;
        previousY = y;
        previousZ = z;
        havePreviousPosition = true;
    }

    private void logState(String reason) {
        if (mc.thePlayer == null) {
            return;
        }

        LOG.info(
            "[BBotPoC] {} phase={} tick={} pos={},{},{} vel={},{},{} yaw={} ground={} sprint={} collidedH={}",
            reason,
            phase,
            totalTicks,
            round3(mc.thePlayer.posX),
            round3(mc.thePlayer.posY),
            round3(mc.thePlayer.posZ),
            round3(mc.thePlayer.motionX),
            round3(mc.thePlayer.motionY),
            round3(mc.thePlayer.motionZ),
            round3(mc.thePlayer.rotationYaw),
            mc.thePlayer.onGround,
            mc.thePlayer.isSprinting(),
            mc.thePlayer.isCollidedHorizontally
        );
    }

    private static int envInt(String key, int fallback) {
        String value = System.getenv(key);
        if (value == null || value.trim().isEmpty()) {
            return fallback;
        }

        try {
            return Math.max(0, Integer.parseInt(value.trim()));
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private static double round3(double value) {
        return Math.round(value * 1000.0D) / 1000.0D;
    }
}
