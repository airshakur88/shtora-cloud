// BENCHMARK: vulnerable - ssrf
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestTemplate;

@RestController
public class ProxyController {
    private final RestTemplate client = new RestTemplate();

    @GetMapping("/proxy")
    public String proxy(@RequestParam String target) {
        return client.getForObject(target, String.class);
    }
}
