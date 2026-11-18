// BENCHMARK: vulnerable - sqli
import jakarta.persistence.EntityManager;
import org.springframework.web.bind.annotation.*;

@RestController
public class SearchController {
    private EntityManager entityManager;

    @GetMapping("/search")
    public Object search(@RequestParam String name) {
        return entityManager.createNativeQuery(
            "SELECT * FROM users WHERE name = '" + name + "'"
        ).getResultList();
    }
}
