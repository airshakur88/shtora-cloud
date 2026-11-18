// BENCHMARK: vulnerable - expression_injection
import org.springframework.expression.ExpressionParser;
import org.springframework.expression.spel.standard.SpelExpressionParser;
import org.springframework.web.bind.annotation.*;

@RestController
public class RuleController {
    private final ExpressionParser parser = new SpelExpressionParser();

    @PostMapping("/evaluate")
    public Object evaluate(@RequestParam String expression) {
        return parser.parseExpression(expression).getValue();
    }
}
