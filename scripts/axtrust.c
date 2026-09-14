// Minimal probe: prints 1 when THIS process (and its responsible parent app,
// e.g. the terminal that launched it) is trusted for Accessibility, else 0.
//
// Build:  clang -framework ApplicationServices scripts/axtrust.c -o /tmp/axtrust
// Run it from the SAME shell/terminal you use to launch `make dev` — the
// "responsible process" macOS attributes the permission to is the app that
// started the process chain (Terminal, iTerm, VS Code, ...), not the binary.
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>

int main(void) {
    printf("AXIsProcessTrusted = %d\n", AXIsProcessTrusted());
    return 0;
}
