// BENCHMARK: safe - parameterized Spring Kotlin native query
import jakarta.persistence.EntityManager
import org.springframework.web.bind.annotation.*

@RestController
class SafeSearchController(private val entityManager: EntityManager) {
    @GetMapping("/search")
    fun search(@RequestParam name: String): Any =
        entityManager.createNativeQuery("SELECT * FROM users WHERE name = :name")
            .setParameter("name", name)
            .resultList
}
