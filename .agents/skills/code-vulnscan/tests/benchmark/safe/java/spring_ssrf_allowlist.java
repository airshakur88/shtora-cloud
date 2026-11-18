// BENCHMARK: safe - SSRF host allowlist
import java.net.URI;
import java.util.Set;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestTemplate;

@RestController
public class SafeProxyController {
    private static final Set<String> ALLOWED_HOSTS = Set.of("api.example.com");
    private final RestTemplate client = new RestTemplate();

    @GetMapping("/proxy")
    public String proxy(@RequestParam String target) {
        URI uri = URI.create(target);
        if (!"https".equals(uri.getScheme())
                || !ALLOWED_HOSTS.contains(uri.getHost())
                || (uri.getPort() != -1 && uri.getPort() != 443)
                || uri.getUserInfo() != null) {
            throw new IllegalArgumentException("destination not allowed");
        }
        return client.getForObject(uri, String.class);
    }
}
