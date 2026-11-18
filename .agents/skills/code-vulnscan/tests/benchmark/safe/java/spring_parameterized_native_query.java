// BENCHMARK: safe - parameterized native query
import jakarta.persistence.EntityManager;
import org.springframework.web.bind.annotation.*;

@RestController
public class SafeSearchController {
    private EntityManager entityManager;

    @GetMapping("/search")
    public Object search(@RequestParam String name) {
        return entityManager.createNativeQuery("SELECT * FROM users WHERE name = :name")
            .setParameter("name", name)
            .getResultList();
    }
}
