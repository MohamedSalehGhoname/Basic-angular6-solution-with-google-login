// Ensure the JIT compiler is available as a fallback for partially-compiled
// libraries (e.g. the router's PlatformLocation) so specs do not depend on
// another spec loading it first.
import '@angular/compiler';
